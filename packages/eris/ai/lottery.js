// ─── Daily lottery ─────────────────────────────────────────────────────────
// Global pool (all servers share one jackpot). Tickets cost 100 coins each.
// Draw fires every 24h at the stored drawAt timestamp. If nobody bought,
// the pot rolls over in full. If one or more bought, a weighted random
// draw picks a winner, pot goes to them, state resets with a 30% rollover
// seed so the next day's pot starts above zero.

import { log } from "../utils/logger.js";

const TICKET_PRICE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLOVER_FRACTION = 0.30; // 30% of the paid-out pot seeds the next one
const HOUSE_SEED = 500;

// In-memory state — mirror of the `bot_data` row with id='eris_lottery'.
let _state = null;
let _loadPromise = null;
let _saveTimer = null;
let _drawInProgress = false;
const _drawQueue = [];
let _lotteryRpcAvailable = true;

function _freshState() {
  return {
    drawAt: Date.now() + DAY_MS,
    pot: HOUSE_SEED, // house seed so the first-ever lottery isn't 0
    tickets: {}, // userId → count
    history: [],
  };
}

// Module-level mutex — draws and purchases mustn't interleave. Implemented
// as a promise chain so every call queues behind the previous one.
/** @type {Promise<any>} */
let _opChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function _withLotteryLock(fn) {
  const next = _opChain.catch(() => {}).then(fn);
  _opChain = next;
  return next;
}

async function _load() {
  if (_state) return _state;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (!sb) { _state = _freshState(); return _state; }
      const { data } = await sb.from("bot_data").select("data").eq("id", "eris_lottery").single();
      const stored = data?.data;
      if (stored && typeof stored === "object" && typeof stored.drawAt === "number") {
        const tickets = {};
        if (stored.tickets && typeof stored.tickets === "object" && !Array.isArray(stored.tickets)) {
          for (const [uid, raw] of Object.entries(stored.tickets)) {
            const n = Number(raw);
            if (!/^\d{5,20}$/.test(String(uid))) continue;
            if (Number.isInteger(n) && n > 0 && n < 1_000_000) tickets[uid] = n;
          }
        }
        const pot = Number(stored.pot);
        _state = {
          drawAt: stored.drawAt,
          pot: Number.isFinite(pot) && pot >= 0 ? Math.floor(pot) : HOUSE_SEED,
          tickets,
          history: Array.isArray(stored.history) ? stored.history.slice(0, 30) : [],
        };
        log(`[Lottery] Loaded state — pot ${_state.pot}, ${Object.keys(_state.tickets).length} buyers, draw <t:${Math.floor(_state.drawAt / 1000)}:R>`);
      } else {
        _state = _freshState();
      }
    } catch (err) {
      log(`[Lottery] Load failed: ${err.message}`);
      _state = _freshState();
    }
    return _state;
  })();
  try { return await _loadPromise; }
  finally { _loadPromise = null; }
}

async function _flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const { getSupabase } = await import("../database.js");
  const sb = getSupabase();
  if (!sb || !_state) return;
  const { error } = await sb.from("bot_data").upsert({ id: "eris_lottery", data: _state });
  if (error) throw new Error(error.message || "lottery save failed");
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try {
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (!sb || !_state) return;
      await sb.from("bot_data").upsert({ id: "eris_lottery", data: _state });
    } catch (err) {
      log(`[Lottery] Save failed: ${err.message}`);
    }
  }, 2000);
}

function _isMissingRpc(error) {
  return error?.code === "PGRST202" || /Could not find the function|does not exist|schema cache/i.test(error?.message || "");
}

function _normalizeState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const drawAt = Number(raw.drawAt);
  const pot = Number(raw.pot);
  const tickets = {};
  if (raw.tickets && typeof raw.tickets === "object" && !Array.isArray(raw.tickets)) {
    for (const [uid, value] of Object.entries(raw.tickets)) {
      const n = Number(value);
      if (/^\d{5,20}$/.test(String(uid)) && Number.isInteger(n) && n > 0 && n < 1_000_000) tickets[uid] = n;
    }
  }
  return {
    drawAt: Number.isFinite(drawAt) ? drawAt : Date.now() + DAY_MS,
    pot: Number.isFinite(pot) && pot >= 0 ? Math.floor(pot) : HOUSE_SEED,
    tickets,
    history: Array.isArray(raw.history) ? raw.history.slice(0, 30) : [],
  };
}

async function _tryLotteryRpc(name, params) {
  if (!_lotteryRpcAvailable) return null;
  const { getSupabase } = await import("../database.js");
  const sb = getSupabase();
  if (!sb?.rpc) return null;
  const { data, error } = await sb.rpc(name, params);
  if (error) {
    if (_isMissingRpc(error)) {
      _lotteryRpcAvailable = false;
      log("[Lottery] Atomic lottery RPCs not deployed — using legacy in-process path. Apply migrations/013_atomic_lottery_rpc.sql for cross-process lottery safety.");
      return null;
    }
    return { ok: false, reason: error.message || "lottery_rpc_failed" };
  }
  if (data?.state) {
    const next = _normalizeState(data.state);
    if (next) _state = next;
  }
  return data || { ok: false, reason: "lottery_rpc_empty" };
}

export async function getLotteryState() {
  return _load();
}

/**
 * Buy N tickets. Atomic — deducts coins inside the user lock AND acquires the
 * lottery-state lock so two rapid buys can't interleave with an active draw.
 *
 * @returns {Promise<
 *   { ok: true, tickets: number, cost: number, pot: number, newBalance: number, userTotal: number }
 *   | { ok: false, reason: string, balance?: number, required?: number, held?: number, max?: number }
 * >}
 */
export async function buyLotteryTicket(userId, count = 1) {
  const rawN = Number(count);
  if (!Number.isFinite(rawN) || rawN <= 0) return { ok: false, reason: "invalid_count" };
  const n = Math.min(Math.max(Math.floor(rawN), 1), 100);
  const cost = n * TICKET_PRICE;

  return _withLotteryLock(async () => {
    const rpcResult = await _tryLotteryRpc("eris_buy_lottery_ticket", {
      p_user_id: userId,
      p_count: n,
      p_ticket_price: TICKET_PRICE,
      p_house_seed: HOUSE_SEED,
      p_day_ms: DAY_MS,
    });
    if (rpcResult) return rpcResult;

    await _load();
    // Reject purchases during draw — caller can retry after the draw completes.
    if (_drawInProgress) return { ok: false, reason: "draw_in_progress" };
    // Reject if the draw clock has already elapsed — tickLotteryDraw will
    // own the state transition.
    if (Date.now() >= _state.drawAt) return { ok: false, reason: "draw_pending" };

    // Per-user accumulation cap — the load path rejects entries ≥ 1_000_000,
    // so we must not let in-memory state grow past the same bound (otherwise
    // the next reload silently discards the user's tickets). Leave headroom.
    const existing = Math.max(0, Math.floor(Number(_state.tickets[userId]) || 0));
    const MAX_PER_USER = 999_000;
    if (existing + n > MAX_PER_USER) {
      return { ok: false, reason: "ticket_cap", held: existing, max: MAX_PER_USER };
    }

    const db = await import("../database.js");
    // The module-level lottery lock doesn't nest with the per-user lock, so
    // the standard tryDeductBalance (which takes its own user lock) is safe.
    const deduct = await db.tryDeductBalance(userId, cost, "lottery", `bought ${n} ticket(s)`);
    if (!deduct.ok) return { ok: false, reason: deduct.reason, balance: deduct.balance, required: cost };

    try {
      _state.pot = Math.floor(_state.pot + cost);
      _state.tickets[userId] = Math.floor((Number(_state.tickets[userId]) || 0) + n);
      // Force a synchronous flush so a crash within the debounce window doesn't
      // lose the ticket while the coin is already debited.
      await _flushSave();
      return { ok: true, tickets: n, cost, pot: _state.pot, newBalance: deduct.newBalance, userTotal: _state.tickets[userId] };
    } catch (err) {
      // Rollback — refund the user since we couldn't persist their ticket.
      // Log the refund path separately so orphaned coin events show up in
      // observability instead of vanishing into .catch(() => {}).
      db.updateBalance(userId, cost, "lottery_refund", "persist failed")
        .catch((refundErr) => log(`[Lottery] REFUND FAIL user=${userId} cost=${cost} err=${refundErr?.message || refundErr}`));
      _state.pot = Math.max(HOUSE_SEED, _state.pot - cost);
      _state.tickets[userId] = Math.max(0, (Number(_state.tickets[userId]) || 0) - n);
      if (_state.tickets[userId] <= 0) delete _state.tickets[userId];
      return { ok: false, reason: err?.message || "persist_failed" };
    }
  });
}

/**
 * Run the draw if the clock is past drawAt. Called by the periodic timer.
 * Uses the same module-level mutex as purchases so no ticket can race the draw.
 *
 * @returns {Promise<null | {
 *   drawFired: boolean,
 *   noBuyers?: boolean,
 *   pot?: number,
 *   payoutFailed?: boolean,
 *   winnerId?: string|null,
 *   prize?: number,
 *   winningCount?: number,
 *   totalTickets?: number,
 *   potBefore?: number,
 *   rollover?: number,
 * }>} the draw outcome, or null when no draw fired this tick
 */
export async function tickLotteryDraw(client) {
  return _withLotteryLock(async () => {
    if (_drawInProgress) return null;
    _drawInProgress = true;
    try {
      const rpcResult = await _tryLotteryRpc("eris_claim_lottery_draw", {
        p_roll: Math.random(),
        p_house_seed: HOUSE_SEED,
        p_day_ms: DAY_MS,
        p_rollover_fraction: ROLLOVER_FRACTION,
      });
      if (rpcResult) {
        if (rpcResult.drawFired === false && rpcResult.reason === "not_due") return null;
        if (rpcResult.drawFired) {
          if (rpcResult.noBuyers) log(`[Lottery] No buyers — rolled over pot ${rpcResult.pot}`);
          else log(`[Lottery] Draw — winner ${rpcResult.winnerId} with ${rpcResult.winningCount}/${rpcResult.totalTickets} tickets, prize ${rpcResult.prize}, rollover ${rpcResult.rollover}`);
        }
        return rpcResult;
      }
    } finally {
      _drawInProgress = false;
    }

    await _load();
    if (Date.now() < _state.drawAt) return null;
    if (_drawInProgress) return null;
    _drawInProgress = true;

    try {
      const ticketsMap = { ..._state.tickets };
      const buyers = Object.keys(ticketsMap).filter(uid => {
        const n = Number(ticketsMap[uid]);
        return /^\d{5,20}$/.test(uid) && Number.isInteger(n) && n > 0;
      });

      if (buyers.length === 0) {
        // No buyers — full rollover to next day
        _state.drawAt = Date.now() + DAY_MS;
        _state.tickets = {};
        _state.history.unshift({ at: Date.now(), winner: null, pot: _state.pot, tickets: 0, note: "no buyers — rolled over" });
        _state.history = _state.history.slice(0, 30);
        await _flushSave();
        log(`[Lottery] No buyers — rolled over pot ${_state.pot}`);
        return { drawFired: true, noBuyers: true, pot: _state.pot };
      }

      // Weighted pick — each ticket is an entry
      const totalTickets = buyers.reduce((sum, uid) => sum + Number(ticketsMap[uid]), 0);
      if (!Number.isFinite(totalTickets) || totalTickets <= 0) {
        // Corrupt ticket data — roll over rather than paying null.
        _state.drawAt = Date.now() + DAY_MS;
        _state.tickets = {};
        _state.history.unshift({ at: Date.now(), winner: null, pot: _state.pot, tickets: 0, note: "invalid ticket state — rolled over" });
        _state.history = _state.history.slice(0, 30);
        await _flushSave();
        log(`[Lottery] Invalid ticket totals — rolled over pot ${_state.pot}`);
        return { drawFired: true, noBuyers: true, pot: _state.pot };
      }

      let winnerId = null;
      let winningCount = 0;
      let roll = Math.floor(Math.random() * totalTickets) + 1;
      for (const uid of buyers) {
        roll -= Number(ticketsMap[uid]);
        if (roll <= 0) { winnerId = uid; winningCount = Number(ticketsMap[uid]); break; }
      }
      // Fallback — floating-point quirks shouldn't be possible with ints, but guard anyway
      if (!winnerId) {
        _state.drawAt = Date.now() + DAY_MS;
        _state.tickets = {};
        _state.history.unshift({ at: Date.now(), winner: null, pot: _state.pot, tickets: 0, note: "no winner selected — rolled over" });
        _state.history = _state.history.slice(0, 30);
        await _flushSave();
        return { drawFired: true, noBuyers: true, pot: _state.pot };
      }

      const potBeforeRollover = _state.pot;
      const rollover = Math.floor(potBeforeRollover * ROLLOVER_FRACTION);
      const prize = potBeforeRollover - rollover;

      // Pay the winner — wrap in their user lock so concurrent balance ops
      // don't race the payout.
      let paid = false;
      try {
        const db = await import("../database.js");
        // Standard locking updateBalance — lottery lock is module-level, not
        // nested with the winner's user lock.
        await db.updateBalance(winnerId, prize, "lottery_win", `won with ${winningCount}/${totalTickets} tickets`);
        paid = true;
      } catch (err) {
        log(`[Lottery] Payout to ${winnerId} failed: ${err.message} — state unchanged, will retry next tick`);
      }

      if (!paid) {
        // Keep state intact so we can retry on the next tick
        return { drawFired: false, payoutFailed: true };
      }

      _state.history.unshift({
        at: Date.now(),
        winner: winnerId,
        pot: potBeforeRollover,
        prize,
        tickets: winningCount,
        totalTickets,
      });
      _state.history = _state.history.slice(0, 30);
      _state.pot = rollover + HOUSE_SEED; // rollover + house seed
      _state.tickets = {};
      _state.drawAt = Date.now() + DAY_MS;
      await _flushSave();

      log(`[Lottery] Draw — winner ${winnerId} with ${winningCount}/${totalTickets} tickets, prize ${prize}, rollover ${rollover}`);
      return { drawFired: true, winnerId, prize, winningCount, totalTickets, potBefore: potBeforeRollover, rollover };
    } finally {
      _drawInProgress = false;
    }
  });
}

export function getTicketPrice() { return TICKET_PRICE; }

// ─── Test-only pure helpers ────────────────────────────────────────────────
// Extracted slices of the weighted-draw + rollover math so the invariants
// can be unit-tested without spinning up Supabase/locks/timers.

/**
 * Run the weighted-draw pick against a ticket map + a pre-computed roll
 * value (so tests can seed without monkey-patching Math.random).
 * Mirrors the loop inside tickLotteryDraw exactly.
 */
export function _testPickWinner(ticketsMap, roll) {
  const buyers = Object.keys(ticketsMap).filter((uid) => {
    const n = Number(ticketsMap[uid]);
    return Number.isInteger(n) && n > 0;
  });
  const totalTickets = buyers.reduce((s, uid) => s + Number(ticketsMap[uid]), 0);
  if (totalTickets <= 0) return { winnerId: null, winningCount: 0, totalTickets };
  let remaining = roll;
  for (const uid of buyers) {
    remaining -= Number(ticketsMap[uid]);
    if (remaining <= 0) {
      return { winnerId: uid, winningCount: Number(ticketsMap[uid]), totalTickets };
    }
  }
  return { winnerId: null, winningCount: 0, totalTickets };
}

/** Pure rollover math — 30% of the pot rolls, the rest is prize. */
export function _testComputeRollover(pot) {
  const p = Math.max(0, Math.floor(Number(pot) || 0));
  const rollover = Math.floor(p * ROLLOVER_FRACTION);
  return { rollover, prize: p - rollover };
}

export const _testConstants = { TICKET_PRICE, ROLLOVER_FRACTION, HOUSE_SEED, MAX_PER_USER: 999_000 };
