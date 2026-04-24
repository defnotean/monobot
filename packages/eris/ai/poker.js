// ─── Multi-player poker (Showdown variant) ────────────────────────────────
// Simplified Texas Hold'em focused on the most valuable 1 command many-users
// play pattern. Not a full streetwise betting game — everyone antes, sees
// their 2 hole cards ephemerally, 5 community cards are dealt publicly, and
// the best 5-card hand wins the pot.
//
// Lifecycle:
//   1. Host calls start_poker(ante) — creates a table, opens for 60s
//   2. Players tap "Join" or call join_poker — each ante'd in atomically
//   3. When countdown ends (min 2 players), deal + evaluate
//   4. Winner gets the full pot, minus a 5% rake to the house
//
// State lives in memory per channel — resolved tables are cleaned up.

import { log } from "../utils/logger.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const LOBBY_DURATION_MS = 60_000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const RAKE_PCT = 0.05;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [
  { label: "2", value: 2 },  { label: "3", value: 3 },  { label: "4", value: 4 },
  { label: "5", value: 5 },  { label: "6", value: 6 },  { label: "7", value: 7 },
  { label: "8", value: 8 },  { label: "9", value: 9 },  { label: "10", value: 10 },
  { label: "J", value: 11 }, { label: "Q", value: 12 }, { label: "K", value: 13 },
  { label: "A", value: 14 },
];

// Active tables — keyed by channelId. One table per channel at a time.
const _tables = new Map();

// Persistence: a flat list of pending antes goes to bot_data every time a
// table's membership changes. On startup, any previously-active tables are
// refunded (we can't recover the 60s setTimeout across restarts). Without
// this, host antes vanish on every deploy.
let _saveDebounce = null;
function _buildSnapshot() {
  const snapshot = [];
  for (const [chId, t] of _tables) {
    if (t.status === "resolved") continue;
    snapshot.push({
      channelId: chId,
      status: t.status,
      antes: [...t.players.values()].map((p) => ({ userId: p.userId, anted: p.anted })),
    });
  }
  return snapshot;
}
function _saveActiveTables() {
  if (_saveDebounce) return;
  _saveDebounce = setTimeout(async () => {
    _saveDebounce = null;
    try {
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (!sb) return;
      await sb.from("bot_data").upsert({ id: "eris_poker_active", data: { tables: _buildSnapshot() } });
    } catch (err) {
      log(`[Poker] persist failed: ${err.message}`);
    }
  }, 1500);
}

/**
 * Synchronous (awaitable) flush — used at critical state transitions like
 * entering "playing" status, so a crash mid-payout doesn't cause the startup
 * sweep to refund antes we've already paid out.
 */
async function _flushActiveTables() {
  if (_saveDebounce) { clearTimeout(_saveDebounce); _saveDebounce = null; }
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("bot_data").upsert({ id: "eris_poker_active", data: { tables: _buildSnapshot() } });
  } catch (err) {
    log(`[Poker] flush failed: ${err.message}`);
  }
}

/**
 * On startup: refund any antes from tables that were in-flight before the
 * previous process exited. Called from events/ready.js.
 */
export async function refundStaleTablesOnStartup() {
  try {
    const { getSupabase, updateBalance, withUserLock } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return { refunded: 0 };
    const { data } = await sb.from("bot_data").select("data").eq("id", "eris_poker_active").single();
    const tables = Array.isArray(data?.data?.tables) ? data.data.tables : [];
    if (!tables.length) return { refunded: 0 };

    // Skip tables that were mid-resolution (status=playing) — those may have
    // paid some winners before the crash; refunding would double-credit.
    const refundable = tables.filter(t => t.status !== "playing" && t.status !== "resolved");
    // Clear FIRST so a crash during refund doesn't cause re-refund on next restart.
    await sb.from("bot_data").upsert({ id: "eris_poker_active", data: { tables: [] } });

    let refunded = 0;
    for (const t of refundable) {
      for (const ante of t.antes || []) {
        const userId = ante?.userId;
        const amt = Number(ante?.anted);
        if (!userId || !Number.isFinite(amt) || amt <= 0) continue;
        try {
          // Each ante is an independent user — use the standard (locked)
          // updateBalance so contention with other concurrent user ops is
          // serialized correctly. (We're not inside any outer user lock.)
          await updateBalance(userId, Math.floor(amt), "poker_refund", "bot restart — stale lobby");
          refunded++;
        } catch (err) {
          log(`[Poker] startup refund failed for ${userId}: ${err.message}`);
        }
      }
    }
    if (refunded > 0) log(`[Poker] startup sweep — refunded ${refunded} stale antes`);
    return { refunded };
  } catch (err) {
    log(`[Poker] startup refund error: ${err.message}`);
    return { refunded: 0, error: err.message };
  }
}

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r.label, value: r.value });
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardString(c) { return `${c.rank}${c.suit}`; }
function handString(cards) { return cards.map(cardString).join(" "); }

// ─── Hand evaluation ──────────────────────────────────────────────────────
// Returns { category, categoryName, ranks } — "ranks" is a lexicographically
// comparable array for tie-breaking. Higher values = better hand.
//
// Categories (higher is better):
//   9 Straight flush · 8 Four of a kind · 7 Full house · 6 Flush
//   5 Straight · 4 Three of a kind · 3 Two pair · 2 Pair · 1 High card
const CATEGORY_NAMES = {
  9: "Straight Flush", 8: "Four of a Kind", 7: "Full House",
  6: "Flush", 5: "Straight", 4: "Three of a Kind",
  3: "Two Pair", 2: "Pair", 1: "High Card",
};

// Exported so the test suite can regression-pin hand evaluation independent
// of the table lifecycle. These are the functions where a bug would actually
// live (the async table handlers just orchestrate).
export function evalFiveCards(cards) { return _evalFiveCards(cards); }
export function compareHands(a, b) { return _compareHands(a, b); }
export function bestFiveOfSeven(cards) { return _bestFiveOfSeven(cards); }

// Pure split-pot distributor. Returns an array of per-winner payouts in
// rank order so the first N winners receive the +1 coin from the floor-
// division leftover. Extracted from resolveTable() so the math is unit-
// testable — the original bug (council C-round) was that leftover coins
// got silently pocketed by the house instead of being distributed.
export function splitPot(totalPot, rakePct, winnerCount) {
  const pot = Math.max(0, Math.floor(Number(totalPot) || 0));
  const rake = Math.max(0, Math.floor(pot * rakePct));
  const payoutPool = Math.max(0, pot - rake);
  const n = Math.max(0, Math.floor(winnerCount));
  if (n === 0) return { rake, payouts: [] };
  const perWinner = Math.floor(payoutPool / n);
  const leftover = payoutPool - perWinner * n;
  const payouts = [];
  for (let i = 0; i < n; i++) payouts.push(perWinner + (i < leftover ? 1 : 0));
  return { rake, payouts };
}

function _evalFiveCards(cards) {
  // Assume exactly 5 cards
  const values = cards.map((c) => c.value).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const byCount = Object.entries(counts)
    .map(([v, c]) => ({ v: Number(v), c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);

  const isFlush = suits.every((s) => s === suits[0]);

  // Straight detection — sort ascending, check gaps; also handle wheel (A-2-3-4-5)
  const asc = [...values].sort((a, b) => a - b);
  let isStraight = true;
  for (let i = 1; i < asc.length; i++) {
    if (asc[i] !== asc[i - 1] + 1) { isStraight = false; break; }
  }
  let straightHigh = asc[4];
  if (!isStraight && JSON.stringify(asc) === JSON.stringify([2, 3, 4, 5, 14])) {
    isStraight = true;
    straightHigh = 5; // wheel — A counts as 1
  }

  if (isStraight && isFlush) return { category: 9, ranks: [straightHigh] };
  if (byCount[0].c === 4) return { category: 8, ranks: [byCount[0].v, byCount[1].v] };
  if (byCount[0].c === 3 && byCount[1]?.c === 2) return { category: 7, ranks: [byCount[0].v, byCount[1].v] };
  if (isFlush) return { category: 6, ranks: values };
  if (isStraight) return { category: 5, ranks: [straightHigh] };
  if (byCount[0].c === 3) return { category: 4, ranks: [byCount[0].v, ...byCount.slice(1).map(b => b.v)] };
  if (byCount[0].c === 2 && byCount[1]?.c === 2) {
    const pairs = [byCount[0].v, byCount[1].v].sort((a, b) => b - a);
    return { category: 3, ranks: [...pairs, byCount[2].v] };
  }
  if (byCount[0].c === 2) return { category: 2, ranks: [byCount[0].v, ...byCount.slice(1).map(b => b.v)] };
  return { category: 1, ranks: values };
}

function _compareHands(a, b) {
  if (a.category !== b.category) return b.category - a.category;
  for (let i = 0; i < Math.max(a.ranks.length, b.ranks.length); i++) {
    const ar = a.ranks[i] ?? 0;
    const br = b.ranks[i] ?? 0;
    if (ar !== br) return br - ar;
  }
  return 0;
}

function combinations(arr, k) {
  const result = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    result.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return result;
}

function _bestFiveOfSeven(cards) {
  let best = null;
  let bestFive = null;
  for (const combo of combinations(cards, 5)) {
    const evaluated = _evalFiveCards(combo);
    if (!best || _compareHands(evaluated, best) < 0) {
      best = evaluated;
      bestFive = combo;
    }
  }
  return { evaluation: best, cards: bestFive };
}

// ─── Table lifecycle ──────────────────────────────────────────────────────

export function getTable(channelId) { return _tables.get(channelId); }

// Per-table lock — serializes ALL mutations (create/join/resolve) so two
// concurrent callers can't both pass a pre-write check. Without this, the
// original MAX_PLAYERS bound and double-join prevention have race windows.
const _tableLocks = new Map();
async function _withTableLock(channelId, fn) {
  const prev = _tableLocks.get(channelId) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _tableLocks.set(channelId, current);
  try { return await current; } finally {
    if (_tableLocks.get(channelId) === current) _tableLocks.delete(channelId);
  }
}

/**
 * Create a new table. Returns { ok, table, error }.
 * Host auto-joins. Serialized against concurrent creates on the same channel.
 */
export async function createTable({ channelId, guildId, hostId, ante }) {
  return _withTableLock(channelId, async () => {
    if (_tables.has(channelId)) {
      return { ok: false, error: "a poker table is already running in this channel" };
    }
    const rawAnte = Number(ante);
    const intAnte = Number.isFinite(rawAnte) ? Math.floor(rawAnte) : 100;
    const parsedAnte = Math.max(10, Math.min(100_000, intAnte));

    const db = await import("../database.js");
    const deduct = await db.tryDeductBalance(hostId, parsedAnte, "poker_ante", "table host");
    if (!deduct.ok) {
      return { ok: false, error: `need ${parsedAnte} coins to ante, you have ${deduct.balance}` };
    }

    // From here on, the host has been debited. Any throw MUST refund.
    try {
      const table = {
        channelId,
        guildId,
        hostId,
        ante: parsedAnte,
        pot: parsedAnte,
        players: new Map([[hostId, { userId: hostId, anted: parsedAnte }]]),
        status: "lobby",
        createdAt: Date.now(),
        openUntil: Date.now() + LOBBY_DURATION_MS,
        messageId: null,
      };
      _tables.set(channelId, table);
      _saveActiveTables();
      return { ok: true, table };
    } catch (err) {
      // Refund on setup failure — standard locking path (no user lock held).
      // Log if the refund itself fails so we have an audit trail for the
      // orphaned ante. Previously this used .catch(() => {}) which silently
      // swallowed refund errors — making it impossible to reconcile.
      db.updateBalance(hostId, parsedAnte, "poker_refund", "create failed")
        .catch((refundErr) => log(`[Poker] REFUND FAIL host=${hostId} ante=${parsedAnte} err=${refundErr?.message || refundErr}`));
      throw err;
    }
  });
}

/**
 * Try to join a table. Returns { ok, table, error }.
 * Serialized per-channel so same-user-double-join and seat-overflow races
 * can't occur — two parallel callers go through the lock sequentially.
 */
export async function joinTable({ channelId, userId }) {
  return _withTableLock(channelId, async () => {
    const table = _tables.get(channelId);
    if (!table) return { ok: false, error: "no poker table in this channel — host one with start_poker" };
    if (table.status !== "lobby") return { ok: false, error: "the table is no longer accepting players" };
    if (table.players.has(userId)) return { ok: false, error: "you're already at the table" };
    if (table.players.size >= MAX_PLAYERS) return { ok: false, error: "the table is full" };

    const db = await import("../database.js");
    const deduct = await db.tryDeductBalance(userId, table.ante, "poker_ante", "joined table");
    if (!deduct.ok) {
      return { ok: false, error: `need ${table.ante} coins to ante, you have ${deduct.balance}` };
    }
    try {
      table.players.set(userId, { userId, anted: table.ante });
      table.pot += table.ante;
      _saveActiveTables();
      return { ok: true, table };
    } catch (err) {
      db.updateBalance(userId, table.ante, "poker_refund", "join failed")
        .catch((refundErr) => log(`[Poker] REFUND FAIL user=${userId} ante=${table.ante} err=${refundErr?.message || refundErr}`));
      throw err;
    }
  });
}

/**
 * Resolve a table — deal, evaluate, pay winner, clean up. Idempotent even
 * under concurrent callers (timer + manual /resolve could both race): the
 * whole body runs under the per-channel table lock, and we claim the
 * "playing" status transition BEFORE any await, so a second entrant bails.
 */
export async function resolveTable(channelId) {
  return _withTableLock(channelId, async () => {
    const table = _tables.get(channelId);
    if (!table) return { ok: false, reason: "no_table" };
    if (table.status === "resolved") return { ok: true, alreadyResolved: true, result: table.result };
    if (table.status === "playing")  return { ok: true, alreadyResolved: true, result: table.result };

    // Claim the status transition synchronously BEFORE any await — two
    // concurrent callers now see different statuses and only one proceeds.
    table.status = "playing";
    // Flush the "playing" state immediately so a mid-payout crash won't
    // cause the startup sweep to refund antes we've already started paying.
    try { await _flushActiveTables(); } catch {}

    const db = await import("../database.js");

    if (table.players.size < MIN_PLAYERS || table.players.size > MAX_PLAYERS) {
      // Refund everyone — per-user lock so concurrent balance ops don't race
      for (const p of table.players.values()) {
        const amt = Number(p?.anted);
        if (!Number.isFinite(amt) || amt <= 0) continue;
        try {
          // Standard lock-taking updateBalance — _withTableLock is per-channel,
          // NOT per-user, so this is not nested.
          await db.updateBalance(p.userId, Math.floor(amt), "poker_refund", "not enough players");
        } catch (err) {
          log(`[Poker] refund to ${p.userId} failed: ${err.message}`);
        }
      }
      table.status = "resolved";
      _tables.delete(channelId);
      _saveActiveTables();
      return { ok: false, reason: "not_enough_players", refunded: true };
    }

    const deck = newDeck();
    const community = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
    const playerHands = new Map();
    for (const p of table.players.values()) {
      const hole = [deck.pop(), deck.pop()];
      const best = bestFiveOfSeven([...hole, ...community]);
      playerHands.set(p.userId, { userId: p.userId, hole, best });
    }
    // Expose hole cards immediately — the View Cards button can now reveal
    // them to their owner even if we're still paying out winners.
    table.hands = playerHands;

    // Rank winners
    const ranked = [...playerHands.values()].sort((a, b) => compareHands(a.best.evaluation, b.best.evaluation));
    const topEval = ranked[0].best.evaluation;
    const winners = ranked.filter((p) => compareHands(p.best.evaluation, topEval) === 0);

    // Split the pot via the pure distributor (tested in tests/ai/poker.test.ts).
    // Keeps rake-accounting and leftover-fair-distribution consolidated in one
    // place, so future rake-tier changes update payout math atomically.
    const { rake, payouts } = splitPot(table.pot, RAKE_PCT, winners.length);
    const perWinner = payouts[0] ?? 0; // just for the result embed's display

    for (let i = 0; i < winners.length; i++) {
      const w = winners[i];
      const amount = payouts[i];
      if (amount <= 0) continue;
      try {
        // _withTableLock is per-channel, not per-user, so the standard lock-
        // acquiring updateBalance path is safe here.
        await db.updateBalance(w.userId, amount, "poker_win", winners.length > 1 ? "tie" : "solo win");
      } catch (err) {
        log(`[Poker] payout to ${w.userId} failed: ${err.message}`);
      }
    }

    table.result = {
      community,
      players: [...playerHands.values()].map((p) => ({
        userId: p.userId,
        hole: p.hole,
        bestCards: p.best.cards,
        category: p.best.evaluation.category,
        categoryName: CATEGORY_NAMES[p.best.evaluation.category],
      })),
      winners: winners.map((w) => w.userId),
      perWinner,
      rake,
      totalPot: table.pot,
    };
    table.status = "resolved";
    _saveActiveTables();

    // Schedule cleanup so the channel can host a new table. Capture the
    // resolved table reference — if a fresh lobby replaces it in the
    // meantime, do NOT delete the new one.
    const resolvedRef = table;
    setTimeout(() => {
      if (_tables.get(channelId) === resolvedRef) {
        _tables.delete(channelId);
        _saveActiveTables();
      }
    }, 60_000);

    return { ok: true, result: table.result };
  });
}

// ─── Embed builders ───────────────────────────────────────────────────────

export function buildLobbyEmbed(table) {
  const playerList = [...table.players.values()].map((p) => `• <@${p.userId}>`).join("\n");
  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle("🃏 Poker Table — Open")
    .setDescription(
      `Ante: **${table.ante.toLocaleString()}** coins\n` +
      `Players (${table.players.size}/${MAX_PLAYERS}):\n${playerList}\n\n` +
      `Closes <t:${Math.floor(table.openUntil / 1000)}:R>. Need at least ${MIN_PLAYERS} players.`
    )
    .setFooter({ text: "Click Join to ante in. Use View Cards to peek at your hole cards after dealing." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`poker:join:${table.channelId}`).setLabel("Join").setEmoji("🪙").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`poker:view:${table.channelId}`).setLabel("View Hole Cards").setEmoji("👁️").setStyle(ButtonStyle.Secondary),
  );
  return { embed, row };
}

export function buildResultEmbed(table) {
  const r = table.result;
  if (!r) return null;

  const communityStr = handString(r.community);
  const playerLines = r.players
    .sort((a, b) => (r.winners.includes(a.userId) ? -1 : r.winners.includes(b.userId) ? 1 : 0))
    .map((p) => {
      const isWinner = r.winners.includes(p.userId);
      const medal = isWinner ? "🏆 " : "";
      return `${medal}<@${p.userId}> — ${handString(p.hole)} · **${p.categoryName}**`;
    }).join("\n");

  const title = r.winners.length === 1
    ? `🏆 <@${r.winners[0]}> wins ${r.perWinner.toLocaleString()} coins!`
    : `🤝 Split pot — ${r.winners.map((w) => `<@${w}>`).join(", ")} each win ${r.perWinner.toLocaleString()}`;

  const embed = new EmbedBuilder()
    .setColor(0x10B981)
    .setTitle("🃏 Showdown")
    .setDescription([
      `**Community:** ${communityStr}`,
      "",
      playerLines,
      "",
      `Pot: **${r.totalPot.toLocaleString()}** · Rake: ${r.rake.toLocaleString()} (${Math.round(RAKE_PCT * 100)}%)`,
      title,
    ].join("\n"));

  return embed;
}

/** Get a specific player's hole cards for ephemeral reveal. */
export function getHoleCards(channelId, userId) {
  const table = _tables.get(channelId);
  if (!table) return null;
  // Only players at this table can peek (no-op for spectators)
  if (!table.players?.has(userId)) return null;
  if (table.status === "resolved") {
    const entry = table.result?.players?.find((p) => p.userId === userId);
    return entry ? { hole: entry.hole, resolved: true } : null;
  }
  // During "playing" (dealt, pre-payout), hole cards ARE known
  if (table.status === "playing" && table.hands?.has(userId)) {
    const hand = table.hands.get(userId);
    return { hole: hand.hole, resolved: false };
  }
  // Lobby — no cards dealt yet
  return null;
}
