/**
 * @file database.js
 * @module packages/eris/database
 *
 * Eris persistence layer over Supabase with a full in-memory fallback. ALL
 * state for the bot — economy, mood, relationships, facts/memory, games,
 * shop, inventory, achievements, loans, bounties, daily challenges, boss
 * battles, pets, territories, heists, auctions, banking, marriages,
 * crafting, cooldowns, per-guild settings and directives — flows through
 * exported getters/setters in this file. Reads are synchronous from cache;
 * writes mutate cache and queue a debounced flush to Supabase.
 *
 * Key tables / domains (Supabase prefix `eris_*`, plus the shared
 * `bot_data` key/value blob for guild settings + server personas):
 *   - eris_economy        — balances, daily streak, lifetime totals, version
 *   - eris_memories       — channel-scoped conversation history (no cache)
 *   - eris_facts          — per-user facts with sensitivity (semantic recall)
 *   - eris_mood           — global Eris mood + energy (cache-of-one)
 *   - eris_relationships  — per-user affinity score + interaction count
 *   - eris_reminders      — pending reminders, drained by scheduler
 *   - eris_personality    — editable system-prompt instructions
 *   - eris_inventory / eris_shop / eris_achievements
 *   - eris_loans / eris_bounties / eris_daily_challenges
 *   - eris_boss / eris_pets / eris_territories
 *   - eris_heists / eris_auctions / eris_roast_battles
 *   - eris_bank / eris_prestige / eris_marriages
 *   - bot_data            — guild_settings, server_personas (JSON blobs)
 *   - local_commands      — outbound command queue for remote workers
 *
 * Cache + flush model:
 *   Mutating helpers call `save(bucket)`, which marks the bucket dirty and
 *   schedules a single 200ms debounced flush (`_DEBOUNCE_MS`). The window
 *   is intentionally tight: a hard crash between mutation and flush drops
 *   at most one batching window of writes per bucket. The
 *   `beforeExit` hook (registered once per process) and the SIGTERM /
 *   SIGINT handlers in index.js call `flushAll()`, which clears the
 *   pending timer, re-marks every persistable bucket dirty, and drains
 *   synchronously with a 4-second timeout so a hung Supabase request
 *   cannot block exit forever.
 *
 * Atomic balance RPC vs version-CAS fallback:
 *   `_updateBalanceUnsafe` prefers the `eris_add_balance` Postgres
 *   function (see migrations/002_atomic_balance_rpc.sql), which does the
 *   read-modify-write inside one transaction with `SELECT … FOR UPDATE`
 *   and is the only path that serializes correctly across multiple bot
 *   processes. If the RPC is not deployed (PGRST202), the module flips
 *   `_rpcAddBalanceAvailable = false` and never retries — every later
 *   call drops straight into the version-CAS retry loop (optimistic
 *   concurrency keyed on the row's `version` column from
 *   migrations/001_add_economy_version.sql). The CAS path is correct for
 *   a single-process bot held together by `withEconLock`, but two
 *   processes hitting the same row can still race; apply migration 002
 *   on any multi-process / multi-replica deployment.
 *
 * REQUIRE_PERSISTENCE env var:
 *   Parsed in config.js as `config.requirePersistence` (default off). When
 *   truthy, `initDatabase()` throws hard if Supabase credentials are missing
 *   or all init retries fail — production deploys flip this so silent in-
 *   memory mode never reaches Render (parity with packages/irene/database.js).
 *   `updateBalance` already refuses to mutate when Supabase is offline
 *   (`economy_unavailable: database offline`) regardless of the flag — that
 *   is the load-bearing guard against silent coin loss.
 *
 * In-memory mode caveats:
 *   With Supabase unconfigured (or all init attempts failed), the bot
 *   still boots and serves reads from the in-memory `data` object plus
 *   per-domain Maps, but every byte vanishes on restart: facts, mood,
 *   relationships, reminders, guild settings, server personas, the
 *   in-progress economy/game state — everything. Most economy-mutating
 *   helpers explicitly refuse to run in this mode rather than letting
 *   the cache drift away from a (non-existent) source of truth.
 *
 * Concurrency model:
 *   `withEconLock(userId, fn)` serializes all balance-touching work for
 *   one user across the in-process call sites (transfers, daily claims,
 *   bank deposit/withdraw, weekly/monthly rewards, pet training, loan
 *   repayments). The public alias `withUserLock` is the same mutex and
 *   is the right entry point for non-balance per-user mutations like
 *   crafting and loot boxes. Inner `*Unsafe` helpers
 *   (`updateBalanceUnsafe`, `tryDeductBalanceUnsafe`) skip the
 *   re-acquisition and MUST only be called from inside an existing
 *   `withEconLock` / `withUserLock` block — otherwise concurrent callers
 *   will race the version-CAS loop. The lock is in-process only; true
 *   cross-process serialization for the economy row comes from the
 *   `eris_add_balance` RPC path.
 *
 * Test surface: packages/eris/tests/db/ covers cache lifecycle, economy
 * math, loan-repay races, pet train cooldowns, daily-challenge
 * completion, and bidOnAuction. Tests mock the Supabase client; live DB
 * is never required to run them.
 */

// ─── packages/eris/database.js ──────────────────────────────────────────
// In-memory read cache + short-debounce flush to Supabase. ALL state for
// economy / mood / relationships / games / etc. lives here behind getters.
// Reads are sync from cache; writes mutate cache + queue a flush.
// The debounce window is intentionally tight (200ms) so a crash between
// mutation and flush drops at most one batching window of writes. SIGINT/
// SIGTERM/beforeExit handlers drain the queue synchronously before exit.
// See docs/start-here.md and section TOC below.
// ─── In-Memory Cache + Short-Debounced Supabase Sync ────────────────────────
//
// ─── TABLE OF CONTENTS ──────────────────────────────────────────────────────
//   1. Setup, init, debounced save infrastructure ............. ~line 20
//   2. Conversations, personality, per-server personas ........ ~line 145
//   3. User content (facts, notes, reminders, snippets) ....... ~line 202
//   4. Mood, relationships, analytics, dashboard stats ........ ~line 354
//   5. Watches (price, news, dreams, deploys) + whitelist ..... ~line 433
//   6. Economy core (balance, daily, transfer, leaderboards) .. ~line 546
//   7. Game state (stats, active games, duels, trivia, prefs) . ~line 901
//   8. Shop, inventory, achievements .......................... ~line 1056
//   9. Loans, bounties, daily challenges ...................... ~line 1194
//  10. Boss battles, pets, territories ....................... ~line 1277
//  11. Heists, auctions, roast battles ....................... ~line 1447
//  12. Banking, prestige, marriage, weekly/monthly rewards ... ~line 1559
//  13. Crafting, cooldowns, activity streaks, career tiers ... ~line 1805
//  14. Pet battles, guild settings, directives, shutdown ..... ~line 1904
// ────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// SETUP, INIT, DEBOUNCED SAVE — Supabase client, in-memory cache shape, the
// initDatabase() loader (with retry), and the debounced bucket-flush writer.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "@supabase/supabase-js";
import { LRUCache } from "@defnotean/shared/LRUCache";
import config from "./config.js";
import { log } from "./utils/logger.js";
import { createHmac } from "node:crypto";

let supabase = null;
let _saveTimer = null;
let _dirty = new Set();

// ─── IN-MEMORY DATA ───
let data = {
  conversations: {},   // channelId → [{role, parts}]
  facts: {},           // `guildId:userId` → [{fact_text, created_at}]
  notes: [],           // [{id, user_id, title, content, created_at}]
  reminders: [],       // [{id, user_id, channel_id, reminder_text, remind_at, status}]
  snippets: [],        // [{id, user_id, name, language, code}]
  mood: { mood_score: 0, energy: 50 },
  relationships: {},   // userId → {affinity_score, interactions_count}
  analytics: [],       // [{tool_name, user_id, channel_id, created_at}]
  guild_settings: {},  // guildId → { feature toggles, channels, ping roles }
};

// ─── INIT ───
export async function initDatabase() {
  if (!config.supabaseEnabled) {
    // REQUIRE_PERSISTENCE=1 → boot must abort instead of silently dropping to
    // in-memory mode. Production deploys flip this; local/dev leaves it at 0.
    // Parity with packages/irene/database.js — silent fallback on Render would
    // burn user state on every deploy.
    if (config.requirePersistence) {
      throw new Error(
        "[DB] REQUIRE_PERSISTENCE=1 but SUPABASE_URL / SUPABASE_KEY are missing or invalid. " +
        "Refusing to boot in in-memory mode. Set valid Supabase credentials or unset REQUIRE_PERSISTENCE."
      );
    }
    log("[DB] Supabase not configured — in-memory only");
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      supabase = createClient(config.supabaseUrl, config.supabaseKey);
      // Load critical data
      await _loadFromSupabase();
      log("[DB] Supabase connected and data loaded");
      return;
    } catch (e) {
      log(`[DB] Init attempt ${attempt}/3 failed: ${e.message}`);
      // Exponential backoff with jitter: ~2s, ~4s, ~8s
      if (attempt < 3) await new Promise(r => setTimeout(r, (2 ** attempt) * 1000 + Math.random() * 500));
    }
  }
  // All retries exhausted — honor REQUIRE_PERSISTENCE rather than silently
  // proceeding with an empty cache.
  supabase = null;
  if (config.requirePersistence) {
    throw new Error(
      "[DB] REQUIRE_PERSISTENCE=1 and all 3 Supabase init attempts failed. " +
      "Refusing to boot in in-memory mode."
    );
  }
  log("[DB] Supabase init failed — falling back to in-memory");
}

async function _loadFromSupabase() {
  if (!supabase) return;

  // Run all queries in parallel — much faster than sequential awaits
  const [moodResult, relsResult, remsResult, gsResult] = await Promise.allSettled([
    supabase.from("eris_mood").select("*").eq("id", "eris").single(),
    supabase.from("eris_relationships").select("*"),
    supabase.from("eris_reminders").select("*").eq("status", "pending"),
    supabase.from("bot_data").select("data").eq("id", "eris_guild_settings").single(),
  ]);

  if (moodResult.status === "fulfilled" && moodResult.value.data) {
    const m = moodResult.value.data;
    // Validate and clamp mood values from DB
    data.mood = {
      mood_score: Math.max(-100, Math.min(100, Number(m.mood_score) || 0)),
      energy: Math.max(0, Math.min(100, Number(m.energy) || 50)),
    };
  }
  if (relsResult.status === "fulfilled" && relsResult.value.data) {
    let pruned = 0;
    for (const r of relsResult.value.data) {
      // Prune stale relationships: zero affinity + <3 interactions = noise
      if ((Number(r.affinity_score) || 0) === 0 && (Number(r.interactions_count) || 0) < 3) {
        pruned++;
        continue;
      }
      data.relationships[r.user_id] = {
        affinity_score: Number(r.affinity_score) || 0,
        interactions_count: Math.max(0, Number(r.interactions_count) || 0),
      };
    }
    if (pruned) log(`[DB] Pruned ${pruned} stale relationships on load`);
  }
  if (remsResult.status === "fulfilled" && remsResult.value.data) {
    data.reminders = remsResult.value.data;
  }
  if (gsResult.status === "fulfilled" && gsResult.value.data?.data) {
    data.guild_settings = gsResult.value.data.data;
  }
}

export function getSupabase() { return supabase; }

// ─── SAVE (short-debounce, ≤200ms) ───
// The window is tight on purpose: any rows that mutate in memory between
// `save()` and the timer firing are at risk if the process dies suddenly.
// 200ms is still enough to batch a burst of edits from the same event handler
// while keeping the data-loss window small. On graceful shutdown the
// `beforeExit` / SIGINT / SIGTERM hooks call `flushAll()` to drain immediately.
const _DEBOUNCE_MS = 200;
function save(bucket) {
  if (bucket) _dirty.add(bucket);
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => _flushSave(), _DEBOUNCE_MS);
}

// ─── FLUSH-FAILURE DURABILITY SIGNAL ───
// Count consecutive flush cycles where the durable store was unreachable
// (every attempted bucket upsert threw). Once the durable store has been
// unreachable for `_FLUSH_FAILURE_THRESHOLD` cycles in a row, economy-mutating
// writes flip to REFUSE — mirroring the offline / in-memory guard — so
// mutations don't silently pile up in cache only to vanish on the next
// restart. A single successful flush resets the counter and re-enables writes.
// Reads keep working from cache the whole time.
//
// SCOPE / CAVEAT: this signal is derived ONLY from the debounced flush of the
// mood / relationships / guild_settings buckets (see _flushSave). Economy rows
// (eris_economy) are written synchronously and never flow through _flushSave,
// so their own write failures do NOT increment this counter. The signal is
// therefore a coarse "is Supabase reachable at all" proxy rather than a direct
// measure of economy-table durability — it works because an outage that drops
// the bucket upserts almost always drops the economy writes too. If finer
// granularity is ever needed, count a direct eris_economy write failure toward
// _consecutiveFlushFailures (and reset it on a successful economy write) so the
// refuse threshold reflects the table that actually matters.
const _FLUSH_FAILURE_THRESHOLD = 5;
let _consecutiveFlushFailures = 0;

/**
 * True while the durable store is reachable enough to trust new economy
 * writes. Flips false after `_FLUSH_FAILURE_THRESHOLD` consecutive flush
 * cycles all failed; flips back true on the next successful flush.
 */
export function isPersistenceHealthy() {
  return _consecutiveFlushFailures < _FLUSH_FAILURE_THRESHOLD;
}

// Throw the same shaped error as the offline guard when persistence has gone
// dark, so economy-mutating callers refuse rather than drift cache out of sync
// with a store that can't be flushed.
function _assertPersistenceHealthy() {
  if (!isPersistenceHealthy()) {
    throw new Error("economy_unavailable: persistence temporarily unavailable");
  }
}

async function _flushSave() {
  _saveTimer = null;
  if (!supabase) return;
  const buckets = [..._dirty];
  _dirty.clear();
  if (!buckets.length) return;

  let anyFailed = false;
  for (const bucket of buckets) {
    try {
      if (bucket === "mood") {
        await supabase.from("eris_mood").upsert({ id: "eris", mood_score: data.mood.mood_score, energy: data.mood.energy, last_updated: new Date().toISOString() });
      }
      if (bucket === "relationships") {
        const rows = Object.entries(data.relationships).map(([uid, r]) => ({
          user_id: uid, affinity_score: r.affinity_score, interactions_count: r.interactions_count, last_interaction: new Date().toISOString(),
        }));
        if (rows.length) await supabase.from("eris_relationships").upsert(rows);
      }
      if (bucket === "guild_settings") {
        await supabase.from("bot_data").upsert({ id: "eris_guild_settings", data: data.guild_settings });
      }
    } catch (e) {
      anyFailed = true;
      log(`[DB] Flush ${bucket} failed: ${e.message} — will retry`);
      _dirty.add(bucket); // re-queue failed bucket for next save cycle
    }
  }

  // Track durable-store reachability. A cycle that fully drained without a
  // single failure means the store answered — reset the counter (re-enabling
  // writes if they had been refused). A cycle where every bucket failed counts
  // as one more consecutive failure toward the refuse threshold.
  if (anyFailed) {
    _consecutiveFlushFailures++;
    if (_consecutiveFlushFailures === _FLUSH_FAILURE_THRESHOLD) {
      log(`[DB] ${_FLUSH_FAILURE_THRESHOLD} consecutive flush failures — refusing economy-mutating writes until a flush succeeds (reads still served from cache)`);
    }
  } else {
    if (_consecutiveFlushFailures >= _FLUSH_FAILURE_THRESHOLD) {
      log(`[DB] Flush recovered — re-enabling economy-mutating writes`);
    }
    _consecutiveFlushFailures = 0;
  }
}

// Set up a beforeExit hook so any clean exit (no SIGTERM/SIGINT, e.g. `process.exit()`
// after main() resolves on test runners) still drains the queue. SIGTERM/SIGINT
// already trigger flushAll() from index.js.
// Guard so the hook is only registered once even if this module gets re-imported.
if (typeof process !== "undefined" && !process.__erisBeforeExitFlush) {
  process.__erisBeforeExitFlush = true;
  process.on("beforeExit", () => {
    if (!_dirty.size && !_saveTimer) return;
    // beforeExit runs sync-ish — we can await inside it, Node will keep the
    // loop alive as long as the returned promise still has work pending.
    // Bound the flush so a hung Supabase request doesn't block exit.
    Promise.race([
      flushAll(),
      new Promise(r => setTimeout(r, 3000)),
    ]).catch(e => log(`[DB] beforeExit flush: ${e.message}`));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATIONS, PERSONALITY, PER-SERVER PERSONAS — chat history (Supabase
// direct), the editable system-prompt instructions, and per-guild name /
// personality overrides loaded once at boot.
// ═══════════════════════════════════════════════════════════════════════════
// ─── CONVERSATIONS (Supabase direct — too large for memory) ───
export async function saveInteraction(userId, username, channelId, content, isBot = false) {
  if (!supabase || !userId || !channelId) return;
  const { error } = await supabase.from("eris_memories").insert({ user_id: userId, username, channel_id: channelId, content, is_bot: isBot });
  if (error) log(`[DB] saveInteraction: ${error.message}`);
}

export async function getRecentHistory(channelId, limit = 15) {
  if (!supabase) return [];
  const { data: rows, error } = await supabase.from("eris_memories").select("*").eq("channel_id", channelId).order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return rows.reverse();
}

// ─── PERSONALITY ───
export async function getPersonality() {
  if (!supabase) return null;
  const { data: row } = await supabase.from("eris_personality").select("instructions").eq("id", "eris").single();
  return row?.instructions || null;
}

export async function updatePersonality(instructions) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_personality").upsert({ id: "eris", instructions });
  return !error;
}

// ─── PER-SERVER PERSONA (name + personality override) ───
const _serverPersonas = new Map(); // guildId → { name, personality }

export function getServerPersona(guildId) {
  return _serverPersonas.get(guildId) || null;
}

export function setServerPersona(guildId, name, personality = null) {
  if (!name && !personality) { _serverPersonas.delete(guildId); }
  else { _serverPersonas.set(guildId, { name: name || "Eris", personality: personality || null }); }
  // Persist to Supabase
  if (supabase) supabase.from("bot_data").upsert({ id: "eris_server_personas", data: Object.fromEntries(_serverPersonas) }).catch(e => log(`[DB] ${e.message}`));
}

export function getAllServerPersonas() { return Object.fromEntries(_serverPersonas); }

// Load persisted personas on startup
(async () => {
  if (!supabase) return;
  try {
    const { data: row } = await supabase.from("bot_data").select("data").eq("id", "eris_server_personas").single();
    if (row?.data) for (const [gid, p] of Object.entries(row.data)) _serverPersonas.set(gid, p);
  } catch (e) { log(`[DB] ${e.message}`); }
})();

// ═══════════════════════════════════════════════════════════════════════════
// USER CONTENT — facts/memory (with sensitivity filtering for public vs
// private context), local commands queue, notes, reminders, and code snippets.
// All of these are per-user persistent stores backed by their own table.
// ═══════════════════════════════════════════════════════════════════════════
// ─── FACTS / MEMORY ───

// Optional TTL for sensitive-tier facts (privacy: emotional disclosures the
// user flagged as "sensitive" shouldn't necessarily live forever). Off by
// default — set SENSITIVE_FACT_TTL_DAYS to a positive integer to enable. Secret
// and normal facts are never auto-expired here (secrets are access-gated and
// never embedded; normal facts persist by importance, not time).
const _SENSITIVE_FACT_TTL_DAYS = (() => {
  const raw = process.env.SENSITIVE_FACT_TTL_DAYS;
  if (raw == null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

// Tracks whether the `expires_at` column (migration 006) is deployed. The first
// insert that trips a column-not-found error flips this off and never retries —
// every later write then drops to the legacy row shape (no expiry) so facts keep
// persisting before migrations/006 is applied. Mirrors the
// `_localCmdSigColsAvailable` latch idiom.
let _factExpiryColAvailable = true;

export async function saveFact(userId, factText, sensitivity = "normal", importance = "normal") {
  if (!supabase) return false;
  const baseRow = { user_id: userId, fact_text: factText, sensitivity, importance: importance || "normal" };
  const row = { ...baseRow };
  // Stamp an expiry only for sensitive-tier facts when a TTL is configured AND
  // the column is known to exist. Degrades to the legacy (no-expiry) shape
  // otherwise so nothing breaks before migration 006.
  if (_factExpiryColAvailable && _SENSITIVE_FACT_TTL_DAYS > 0 && sensitivity === "sensitive") {
    row.expires_at = new Date(Date.now() + _SENSITIVE_FACT_TTL_DAYS * 86_400_000).toISOString();
  }
  const { error } = await supabase.from("eris_facts").insert(row);
  if (error) {
    // Migration 006 (expires_at column) not applied yet — retry with the legacy
    // shape so fact writes keep succeeding. Latch the column off for the process
    // lifetime so we don't pay the failed round-trip on every write.
    if (_factExpiryColAvailable && row.expires_at !== undefined &&
        (error.code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(error.message || ""))) {
      _factExpiryColAvailable = false;
      log(`[DB] saveFact: eris_facts.expires_at column missing — falling back to no-expiry inserts. Apply migrations/006_facts_expiry.sql to enable sensitive-fact TTL.`);
      const { error: retryErr } = await supabase.from("eris_facts").insert(baseRow);
      return !retryErr;
    }
    return false;
  }
  return true;
}

export async function getFacts(userId, limit = 20) {
  if (!supabase) return [];
  // Newest-first so a long-term user's most recent facts reach context rather
  // than being crowded out by the oldest `limit` rows. Coordinates with the
  // write-side cap enforced in memory.js/memoryExecutor.js.
  // Selecting expires_at (when present) lets us hide already-expired sensitive
  // facts from context immediately, even before the prune cron sweeps the row.
  // The column may not exist pre-migration-006; PostgREST silently omits it and
  // the filter below is a no-op in that case.
  const { data: rows } = await supabase.from("eris_facts").select("id, fact_text, sensitivity, expires_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  return _filterExpiredFacts(rows);
}

// Drop facts whose expires_at has passed. Rows without the column (legacy /
// pre-migration) carry no expires_at and are always kept.
function _filterExpiredFacts(rows) {
  if (!rows) return [];
  const now = Date.now();
  return rows.filter(r => {
    if (!r || r.expires_at == null) return true;
    const t = Date.parse(r.expires_at);
    return !Number.isFinite(t) || t > now;
  });
}

/**
 * Hard-delete sensitive-tier facts whose expires_at has elapsed. Best-effort:
 * returns 0 (and logs nothing loud) when the column is missing or Supabase is
 * offline. Intended to be called from the same maintenance cron that prunes
 * episodic memories. Degrades safely everywhere.
 */
export async function pruneExpiredFacts() {
  if (!supabase || !_factExpiryColAvailable) return { deleted: 0 };
  try {
    const result = await supabase
      .from("eris_facts")
      .delete()
      .not("expires_at", "is", null)
      .lt("expires_at", new Date().toISOString());
    if (result?.error) {
      if (/column .* does not exist|Could not find the .* column/i.test(result.error.message || "")) {
        _factExpiryColAvailable = false;
      }
      return { deleted: 0 };
    }
    return { deleted: result?.count ?? 0 };
  } catch {
    return { deleted: 0 };
  }
}

export async function getFactsGlobal(userId, limit = 20) {
  if (!supabase) return [];
  // Get facts across all servers — no guild filter. Selecting + filtering
  // expires_at keeps this consistent with getFacts so a future caller that
  // builds context off getFactsGlobal can't surface already-expired sensitive
  // facts. No-op pre-migration-006 (PostgREST omits the missing column).
  const { data: rows } = await supabase.from("eris_facts").select("id, fact_text, sensitivity, expires_at").eq("user_id", userId).order("created_at", { ascending: true }).limit(limit);
  return _filterExpiredFacts(rows);
}

export async function deleteFactByText(userId, searchText) {
  if (!supabase) return false;
  const facts = await getFacts(userId);
  const lower = searchText.toLowerCase();
  const match = facts.find(f => (f.fact_text || "").toLowerCase().includes(lower));
  if (!match) return { success: false, error: "no matching memory found" };
  const { error } = await supabase.from("eris_facts").delete().eq("id", match.id).eq("user_id", userId);
  return error ? { success: false, error: error.message } : { success: true, deleted: match.fact_text };
}

export async function clearAllFacts(userId) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_facts").delete().eq("user_id", userId);
  return !error;
}

/**
 * Get only facts that are safe to show in a given context.
 * - "private" context: returns ALL facts (including secrets) — used when building context for this user only
 * - "public" context: returns only "normal" facts — used when another user asks about someone
 */
export async function getFactsFiltered(userId, context = "private") {
  const allFacts = await getFacts(userId);
  if (context === "private") return allFacts; // user gets to see their own secrets in context
  return allFacts.filter(f => (f.sensitivity || "normal") === "normal"); // others only see normal facts
}

export async function deleteFact(userId, factId) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_facts").delete().eq("id", factId).eq("user_id", userId);
  return !error;
}

// ─── LOCAL COMMANDS ───
// One-time warning latch so an unsigned-enqueue config gap is logged loudly
// without spamming the log on every command.
let _localCmdSignWarned = false;
// Tracks whether the sig/ts columns (migration 004) are deployed. The first
// insert that trips a column-not-found error flips this to false and never
// retries — every later enqueue then drops straight to the legacy row shape so
// the command queue keeps working before migrations/004 is applied. Mirrors the
// `_rpcAddBalanceAvailable` latch idiom above.
let _localCmdSigColsAvailable = true;

export async function queueLocalCommand(command, channelId, requestedBy) {
  if (!supabase) return false;
  // The PC-agent poller requires an HMAC signature over the request so a
  // forged local_commands row can't drive owner machine-level execution.
  // sig = HMAC_SHA256(secret, `${requested_by}.${command}.${ts}`).
  const ts = Date.now();
  const secret = config.twinApiSecret || config.pcAgentSecret || null;
  // Legacy row shape (pre-migration-004): no sig/ts columns.
  const baseRow = { command, channel_id: channelId, requested_by: requestedBy, status: "pending" };
  const row = { ...baseRow };
  if (_localCmdSigColsAvailable) {
    row.ts = ts;
    if (secret) {
      row.sig = createHmac("sha256", secret).update(`${requestedBy}.${command}.${ts}`).digest("hex");
    } else if (!_localCmdSignWarned) {
      _localCmdSignWarned = true;
      log(`[DB] queueLocalCommand: NO twinApiSecret/pcAgentSecret configured — enqueuing UNSIGNED local commands. The PC-agent poller will reject these. Set TWIN_API_SECRET.`);
    }
  }
  const { error } = await supabase.from("local_commands").insert(row);
  if (error) {
    // Migration 004 (sig/ts columns) not applied yet — PostgREST reports the
    // unknown column as PGRST204 / "column ... does not exist" / "Could not
    // find the ... column". Latch the columns off for the process lifetime and
    // retry with the legacy row so PC-agent enqueues still succeed.
    if (_localCmdSigColsAvailable &&
        (error.code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(error.message || ""))) {
      _localCmdSigColsAvailable = false;
      log(`[DB] queueLocalCommand: local_commands.sig/ts columns missing — falling back to unsigned legacy enqueue. Apply migrations/004_local_commands_signature.sql to enable signed commands.`);
      const { error: retryErr } = await supabase.from("local_commands").insert(baseRow);
      return !retryErr;
    }
    return false;
  }
  return true;
}

// ─── NOTES ───
export async function saveNote(userId, title, content) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_notes").insert({ user_id: userId, title, content });
  return !error;
}

export async function getNotes(userId, limit = 20) {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_notes").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  return rows || [];
}

export async function deleteNote(userId, noteId) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_notes").delete().eq("id", noteId).eq("user_id", userId);
  return !error;
}

export async function searchNotes(userId, query) {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_notes").select("*").eq("user_id", userId).or(`title.ilike.%${query}%,content.ilike.%${query}%`).limit(10);
  return rows || [];
}

// ─── REMINDERS ───
export async function saveReminder(userId, channelId, text, remindAt) {
  if (!supabase) return false;
  const row = { user_id: userId, channel_id: channelId, reminder_text: text, remind_at: remindAt, status: "pending" };
  // Return the inserted row so the cache carries the DB-assigned id. Without it
  // the cached row has no id and markReminderDone (which filters by id) can
  // never evict it — the reminder lingers in the cache forever.
  const { data: inserted, error } = await supabase.from("eris_reminders").insert(row).select().single();
  if (!error) data.reminders.push(inserted ? { ...inserted } : row);
  return !error;
}

export async function getPendingReminders() {
  if (!supabase) return [];
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);
  const { data: rows } = await supabase.from("eris_reminders").select("*").eq("status", "pending").gte("remind_at", fiveMinAgo.toISOString()).lte("remind_at", now.toISOString());
  return rows || [];
}

export async function markReminderDone(id) {
  if (!supabase) return;
  await supabase.from("eris_reminders").update({ status: "done" }).eq("id", id);
  data.reminders = data.reminders.filter(r => r.id !== id);
}

export async function markRemindersDoneBatch(ids) {
  if (!supabase || !ids.length) return;
  await supabase.from("eris_reminders").update({ status: "done" }).in("id", ids);
  const idSet = new Set(ids);
  data.reminders = data.reminders.filter(r => !idSet.has(r.id));
}

export async function getUserReminders(userId) {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_reminders").select("*").eq("user_id", userId).eq("status", "pending").order("remind_at", { ascending: true });
  return rows || [];
}

export async function cancelReminder(userId, id) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_reminders").update({ status: "cancelled" }).eq("id", id).eq("user_id", userId);
  return !error;
}

// ─── SNIPPETS ───
export async function saveSnippet(userId, name, language, code) {
  if (!supabase) return false;
  await supabase.from("eris_snippets").delete().eq("user_id", userId).eq("name", name);
  const { error } = await supabase.from("eris_snippets").insert({ user_id: userId, name, language, code });
  return !error;
}

export async function getSnippet(userId, name) {
  if (!supabase) return null;
  const { data: row } = await supabase.from("eris_snippets").select("*").eq("user_id", userId).eq("name", name).single();
  return row;
}

export async function listSnippets(userId) {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_snippets").select("name, language, created_at").eq("user_id", userId).order("created_at", { ascending: false });
  return rows || [];
}

// ═══════════════════════════════════════════════════════════════════════════
// MOOD, RELATIONSHIPS, ANALYTICS, DASHBOARD — the bot's emotional state and
// per-user affinity scores (in-memory, debounced to Supabase) plus tool-usage
// analytics and the aggregate dashboard counters.
// ═══════════════════════════════════════════════════════════════════════════
// ─── MOOD (in-memory + debounced sync) ───
export function getMood() {
  return { ...data.mood };
}

export function updateMood(score, energy) {
  data.mood.mood_score = Math.max(-100, Math.min(100, score));
  data.mood.energy = Math.max(0, Math.min(100, energy));
  save("mood");
}

export function shiftMood(delta, energyDelta = 0) {
  updateMood(data.mood.mood_score + delta, data.mood.energy + energyDelta);
}

// ─── RELATIONSHIPS (in-memory + debounced sync) ───
export function getRelationship(userId) {
  return data.relationships[userId] || { affinity_score: 0, interactions_count: 0 };
}

export function updateRelationship(userId, affinityDelta) {
  const current = getRelationship(userId);
  data.relationships[userId] = {
    affinity_score: Math.max(-100, Math.min(100, current.affinity_score + affinityDelta)),
    interactions_count: current.interactions_count + 1,
  };
  save("relationships");
}

export async function getAllRelationships() {
  // Merge in-memory (always latest) with Supabase (persisted)
  const merged = {};

  // Load from Supabase first (baseline)
  if (supabase) {
    const { data: rows } = await supabase.from("eris_relationships").select("*").order("affinity_score", { ascending: false });
    for (const r of (rows || [])) merged[r.user_id] = r;
  }

  // Override with in-memory data (always fresher)
  for (const [uid, r] of Object.entries(data.relationships)) {
    merged[uid] = { user_id: uid, ...r };
  }

  return Object.values(merged).sort((a, b) => b.affinity_score - a.affinity_score);
}

// ─── ANALYTICS ───
export async function logToolUsage(toolName, userId, channelId) {
  if (!supabase) return;
  await supabase.from("eris_analytics").insert({ tool_name: toolName, user_id: userId, channel_id: channelId });
}

export async function getAnalytics(days = 7) {
  if (!supabase) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: rows } = await supabase.from("eris_analytics").select("*").gte("created_at", since).order("created_at", { ascending: false });
  return rows || [];
}

// ─── DASHBOARD STATS ───
export async function getDashboardStats() {
  if (!supabase) return { messages: 0, users: 0, commands: 0, channels: 0 };
  try {
    const { count: msgCount } = await supabase.from("eris_memories").select("*", { count: "exact", head: true });
    const { data: users } = await supabase.from("eris_memories").select("user_id").eq("is_bot", false);
    const uniqueUsers = new Set((users || []).map(u => u.user_id)).size;
    const { data: channels } = await supabase.from("eris_memories").select("channel_id");
    const uniqueChannels = new Set((channels || []).map(c => c.channel_id)).size;
    const { count: cmdCount } = await supabase.from("eris_analytics").select("*", { count: "exact", head: true });
    return { messages: msgCount || 0, users: uniqueUsers, commands: cmdCount || 0, channels: uniqueChannels };
  } catch { return { messages: 0, users: 0, commands: 0, channels: 0 }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// WATCHES & SHARED WHITELIST — long-poll subscriptions for prices, news
// topics, deploy status; recent dream log; and the cross-twin server
// whitelist (read from Irene's bot_data row so both bots stay in sync).
// ═══════════════════════════════════════════════════════════════════════════
// ─── PRICE WATCHES ───
export async function addPriceWatch(userId, channelId, url, productName, targetPrice) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_price_watches").insert({ user_id: userId, channel_id: channelId, url, product_name: productName, target_price: targetPrice });
  return !error;
}
export async function getPriceWatches() {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_price_watches").select("*");
  return rows || [];
}
export async function removePriceWatch(userId, id) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_price_watches").delete().eq("id", id).eq("user_id", userId);
  return !error;
}

// ─── NEWS WATCHES ───
export async function addNewsWatch(userId, channelId, topic) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_news_watches").insert({ user_id: userId, channel_id: channelId, topic });
  return !error;
}
export async function getNewsWatches() {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_news_watches").select("*");
  return rows || [];
}
export async function removeNewsWatch(userId, id) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_news_watches").delete().eq("id", id).eq("user_id", userId);
  return !error;
}

// ─── DREAMS ───
export async function getRecentDreams(limit = 3) {
  if (!supabase) return [];
  const { data } = await supabase
    .from("eris_dreams")
    .select("content, mood_context, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(10, limit)));
  return data || [];
}

export async function saveDream(content, moodContext) {
  if (!supabase) return;
  await supabase.from("eris_dreams").insert({ content, mood_context: moodContext });
}

// ─── DEPLOY WATCHES ───
export async function addDeployWatch(service, projectId, channelId) {
  if (!supabase) return false;
  const { error } = await supabase.from("eris_deploy_watches").insert({ service, project_id: projectId, channel_id: channelId });
  return !error;
}
export async function getDeployWatches() {
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_deploy_watches").select("*");
  return rows || [];
}

// ─── SHARED WHITELIST (reads from Irene's bot_data table) ───
// Both twins share the same server whitelist so they stay in sync
export async function getWhitelist() {
  if (!supabase) { log(`[WHITELIST] getWhitelist: supabase not configured`); return {}; }
  const { data: row, error } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (error && error.code !== "PGRST116") {
    log(`[WHITELIST] getWhitelist failed: ${error.message} (code=${error.code})`);
    return {};
  }
  return row?.data?.server_whitelist || {};
}

export async function isWhitelisted(guildId) {
  const wl = await getWhitelist();
  return !!wl[guildId];
}

export async function addToWhitelist(guildId, info) {
  if (!supabase) { log(`[WHITELIST] addToWhitelist: supabase not configured`); return false; }
  const { data: row, error: selectErr } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (selectErr && selectErr.code !== "PGRST116") {
    log(`[WHITELIST] addToWhitelist select failed: ${selectErr.message} (code=${selectErr.code})`);
    return false;
  }
  const botData = row?.data || {};
  if (!botData.server_whitelist) botData.server_whitelist = {};
  botData.server_whitelist[guildId] = {
    name: info.name || "Unknown",
    icon_url: info.icon_url || null,
    members: info.members || null,
    invited_by: info.invited_by || null,
    added_at: new Date().toISOString(),
  };
  const { error: upsertErr } = await supabase.from("bot_data").upsert({ id: "main", data: botData });
  if (upsertErr) {
    log(`[WHITELIST] addToWhitelist upsert failed for ${guildId}: ${upsertErr.message} (code=${upsertErr.code})`);
    return false;
  }
  return true;
}

export async function removeFromWhitelist(guildId) {
  if (!supabase) { log(`[WHITELIST] removeFromWhitelist: supabase not configured`); return false; }
  const { data: row, error: selectErr } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (selectErr && selectErr.code !== "PGRST116") {
    log(`[WHITELIST] removeFromWhitelist select failed: ${selectErr.message} (code=${selectErr.code})`);
    return false;
  }
  const botData = row?.data || {};
  if (botData.server_whitelist?.[guildId]) {
    delete botData.server_whitelist[guildId];
    const { error: upsertErr } = await supabase.from("bot_data").upsert({ id: "main", data: botData });
    if (upsertErr) {
      log(`[WHITELIST] removeFromWhitelist upsert failed for ${guildId}: ${upsertErr.message} (code=${upsertErr.code})`);
      return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ECONOMY CORE — coin balances with per-user locks (withEconLock), atomic
// transfers, daily reward / streak claim, message-earn cooldowns, and the
// multi-axis leaderboard query helpers. All mutations go through versioned
// optimistic updates with retry to prevent double-spend races.
// ═══════════════════════════════════════════════════════════════════════════
// ─── ECONOMY ───────────────────────────────────────────────────────────────

const _economyCache = {}; // userId → {balance, daily_streak, last_daily, ...}
const _economyCacheTimes = new Map(); // userId → timestamp of when cached
const ECONOMY_CACHE_TTL = 10_000; // 10 seconds
const _earnCooldown = new Map(); // userId → timestamp
const _economyLocks = new Map(); // userId → Promise (per-user lock to prevent race conditions)

// Periodically evict stale economy cache entries (every 5 minutes)
// Prevents unbounded growth when many unique users interact over time
setInterval(() => {
  const now = Date.now();
  const cutoff = now - ECONOMY_CACHE_TTL * 6; // keep entries up to 60s old
  for (const [uid, ts] of _economyCacheTimes) {
    if (ts < cutoff) {
      _economyCacheTimes.delete(uid);
      delete _economyCache[uid];
    }
  }
  // Evict stale earn cooldowns (>30s old)
  for (const [uid, ts] of _earnCooldown) {
    if (now - ts > 30_000) _earnCooldown.delete(uid);
  }
  // Evict generic per-tool cooldowns older than 2h — past the longest cooldown
  // window (1h rob/pet_train) so the entry can't change any future check, but
  // accumulates one row per (user, tool) forever otherwise.
  for (const [key, ts] of _cooldowns) {
    if (now - ts > 7_200_000) _cooldowns.delete(key);
  }
  // Bound _careerTiers: it's a cumulative per-user count with no timestamp, so
  // we can't expire by staleness without losing progress. Cap the map size and
  // drop the oldest-inserted entries (Map preserves insertion order) — a
  // re-derived count from a fresh entry only costs a user some work-tier bonus
  // they had to re-earn, never coins.
  const CAREER_TIER_MAX = 5000;
  if (_careerTiers.size > CAREER_TIER_MAX) {
    const overflow = _careerTiers.size - CAREER_TIER_MAX;
    let dropped = 0;
    for (const uid of _careerTiers.keys()) {
      if (dropped++ >= overflow) break;
      _careerTiers.delete(uid);
    }
  }
}, 300_000);

/** Acquire a per-user lock for atomic economy operations */
async function withEconLock(userId, fn) {
  // Wait for any previous operation on this user to finish, then run fn()
  // If previous op failed, still proceed (don't block forever)
  const prev = _economyLocks.get(userId) ?? Promise.resolve();
  const current = prev.catch(e => log(`[DB] ${e.message}`)).then(fn);
  _economyLocks.set(userId, current);
  try { return await current; } finally {
    if (_economyLocks.get(userId) === current) _economyLocks.delete(userId);
  }
}

/**
 * Public alias — same lock, semantically used for generic inventory /
 * item operations where "economy" in the name would be misleading. Use
 * this for crafting, loot boxes, item consumption, and any other
 * user-scoped mutation that isn't strictly balance-related.
 */
export async function withUserLock(userId, fn) {
  return withEconLock(userId, fn);
}

export async function getBalance(userId) {
  // Check cache first (with TTL)
  const cachedAt = _economyCacheTimes.get(userId) || 0;
  if (_economyCache[userId] && (Date.now() - cachedAt < ECONOMY_CACHE_TTL)) return { ..._economyCache[userId] };
  if (!supabase) return { balance: 100, daily_streak: 0, last_daily: null, total_earned: 0, total_lost: 0, total_gambled: 0 };

  try {
    const { data: row } = await supabase.from("eris_economy").select("*").eq("user_id", userId).single();
    if (row) {
      _economyCache[userId] = row;
      _economyCacheTimes.set(userId, Date.now());
      return { ...row };
    }
  } catch (e) {
    log(`[DB] getBalance query failed: ${e.message}`);
    // Return cached or default on Supabase failure
    return _economyCache[userId] ? { ..._economyCache[userId] } : { balance: 100, daily_streak: 0, last_daily: null, total_earned: 0, total_lost: 0, total_gambled: 0 };
  }
  // Initialize new user
  const defaults = { user_id: userId, balance: 100, daily_streak: 0, last_daily: null, total_earned: 0, total_lost: 0, total_gambled: 0, total_stolen: 0, total_stolen_from: 0, last_rob_attempt: null, version: 0 };
  try { await supabase.from("eris_economy").insert(defaults); } catch (e) { log(`[DB] ${e.message}`); }
  _economyCache[userId] = defaults;
  _economyCacheTimes.set(userId, Date.now());
  return { ...defaults };
}

// Tracks whether the `eris_add_balance` RPC is deployed. The first call probes;
// if Postgres reports the function doesn't exist (PGRST202 / "Could not find the function"),
// we flip this to false and never retry — the version-CAS loop below stays the
// fallback path for self-hosters who haven't applied migration 002 yet.
let _rpcAddBalanceAvailable = true;

// Inner balance update — assumes caller already holds withEconLock for userId.
// Do not call directly from outside database.js; use updateBalance() or transferBalance().
//
// Preferred path: the `eris_add_balance` Postgres function (see migration 002)
// does the read-modify-write inside one transaction with SELECT … FOR UPDATE,
// which is a tighter atomicity guarantee than the optimistic-concurrency loop
// below — and it serializes correctly across multiple bot processes, not just
// the in-process withEconLock callers.
//
// Fallback path: if the RPC isn't deployed (or fails for any other reason),
// fall through to the version-CAS retry loop. The semantics are identical
// from the caller's perspective.
async function _updateBalanceUnsafe(userId, delta, type, details) {
  // Guard at the top — a NaN/Infinity delta corrupts DB + cache.
  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    throw new Error(`invalid balance delta: ${delta}`);
  }

  // ── RPC fast path: one round-trip, server-side atomic ───────────────────
  if (supabase && _rpcAddBalanceAvailable) {
    try {
      const { data: rows, error } = await supabase.rpc("eris_add_balance", {
        p_user_id: userId,
        p_delta: delta,
        p_type: type ?? "other",
        p_details: details ?? "",
      });
      if (error) {
        // PGRST202 = function not found. Disable the RPC path for the rest of
        // the process lifetime so we don't pay this round-trip on every call.
        if (error.code === "PGRST202" || /Could not find the function|does not exist/i.test(error.message || "")) {
          _rpcAddBalanceAvailable = false;
          log(`[DB] eris_add_balance RPC not deployed — falling back to version-CAS path. Apply migrations/002_atomic_balance_rpc.sql to enable atomic updates.`);
        } else {
          // Any other RPC error: fall through to the CAS loop, which has its
          // own retry/recovery logic. Don't permanently disable the RPC for
          // transient errors.
          log(`[DB] eris_add_balance RPC error: ${error.message} — falling back to version-CAS for this call`);
        }
      } else if (Array.isArray(rows) && rows.length === 0) {
        // Empty result set = SQL returned without RETURN NEXT, which means
        // the function refused the update (insufficient balance).
        const current = await getBalance(userId);
        const err = new Error("insufficient_balance");
        err.code = "insufficient_balance";
        err.balance = Number(current?.balance) || 0;
        throw err;
      } else if (Array.isArray(rows) && rows.length > 0) {
        const updated = rows[0];
        // Refresh cache from RPC result, preserving streak/daily fields that
        // the RPC doesn't touch (we only fetch the columns it returns).
        const prev = _economyCache[userId] || {};
        _economyCache[userId] = {
          ...prev,
          ...updated,
        };
        _economyCacheTimes.set(userId, Date.now());
        await logTransaction(userId, type, delta, Number(updated.balance) || 0, details);
        return Number(updated.balance) || 0;
      }
    } catch (e) {
      // Re-throw insufficient_balance — that's a contract, not a fallthrough trigger.
      if (e?.code === "insufficient_balance") throw e;
      // Network/transport errors: log and fall through to the CAS loop.
      log(`[DB] eris_add_balance RPC threw: ${e.message} — falling back to version-CAS for this call`);
    }
  }

  // ── Version-CAS fallback (also used when supabase is null) ──────────────
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const current = await getBalance(userId);
    const currentBalance = Number(current.balance) || 0;
    const wouldBe = currentBalance + delta;
    if (wouldBe < 0) {
      // Respect the "never negative" invariant at the API layer so callers
      // see a real error rather than a silent clamp.
      const err = new Error("insufficient_balance");
      err.code = "insufficient_balance";
      err.balance = currentBalance;
      throw err;
    }
    const newBalance = wouldBe;

    const updates = { balance: newBalance };
    if (delta > 0) updates.total_earned = (current.total_earned || 0) + delta;
    // Prestige resets intentionally zero out the balance — don't pollute the
    // "most lost" leaderboard with those.
    if (delta < 0 && type !== "prestige") updates.total_lost = (current.total_lost || 0) + Math.abs(delta);
    if (typeof type === "string" && type.startsWith("gamble")) updates.total_gambled = (current.total_gambled || 0) + Math.abs(delta);
    if (type === "rob_success") updates.total_stolen = (current.total_stolen || 0) + delta;
    if (type === "rob_victim") updates.total_stolen_from = (current.total_stolen_from || 0) + Math.abs(delta);

    const currentVersion = current.version || 0;
    updates.version = currentVersion + 1;

    if (supabase) {
      const { error: upsertErr, data: upsertData } = await supabase
        .from("eris_economy")
        .update({ ...updates })
        .eq("user_id", userId)
        .eq("version", currentVersion)
        .select("user_id");

      if (upsertErr) {
        log(`[DB] updateBalance error for ${userId}: ${upsertErr.message}`);
        throw new Error(`db_update_failed: ${upsertErr.message}`);
      }
      if (!upsertData || upsertData.length === 0) {
        // Version conflict — drop cache, back off, retry from the top so we
        // re-check the insufficient-balance invariant against fresh data.
        log(`[DB] updateBalance version conflict for ${userId} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        _economyCacheTimes.delete(userId);
        delete _economyCache[userId];
        if (attempt >= MAX_RETRIES) {
          throw new Error("version_conflict_exhausted");
        }
        // Exponential backoff with jitter to avoid thundering herd
        const wait = 10 * (1 << attempt) + Math.floor(Math.random() * 15);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }
    _economyCache[userId] = { ...current, ...updates };
    _economyCacheTimes.set(userId, Date.now());

    await logTransaction(userId, type, delta, newBalance, details);
    return newBalance;
  }
  throw new Error("version_conflict_exhausted");
}

export async function updateBalance(userId, delta, type = "other", details = "") {
  // Block economy mutations when the DB is offline — prevents in-memory drift
  // that would silently vanish on next restart.
  if (!supabase) throw new Error("economy_unavailable: database offline");
  // Same refusal once the durable store has been unreachable for too long: a
  // write we can't flush is a write that vanishes on restart.
  _assertPersistenceHealthy();
  return withEconLock(userId, () => _updateBalanceUnsafe(userId, delta, type, details));
}

/**
 * Inner-only updateBalance for callers that ALREADY hold `withUserLock` /
 * `withEconLock` for this user — calling updateBalance (which re-acquires the
 * lock) inside the same lock causes a non-reentrant deadlock. Use this when
 * you've already opened the lock at a higher level (e.g. batch operations,
 * resolveTable payouts, multi-step workflows).
 */
export async function updateBalanceUnsafe(userId, delta, type = "other", details = "") {
  if (!supabase) throw new Error("economy_unavailable: database offline");
  _assertPersistenceHealthy();
  return _updateBalanceUnsafe(userId, delta, type, details);
}

/**
 * Lock-free tryDeduct — same invariant as `updateBalanceUnsafe`. Use when the
 * caller already holds the user lock.
 */
export async function tryDeductBalanceUnsafe(userId, amount, type = "deduct", details = "") {
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  const current = await getBalance(userId);
  if (current.balance < amount) {
    return { ok: false, reason: "insufficient", balance: current.balance, required: amount };
  }
  try {
    const newBalance = await _updateBalanceUnsafe(userId, -amount, type, details);
    return { ok: true, newBalance };
  } catch (err) {
    if (err?.code === "insufficient_balance") {
      return { ok: false, reason: "insufficient", balance: err.balance ?? current.balance };
    }
    throw err;
  }
}

/**
 * Atomic coin transfer between two users — holds both locks (in sorted ID order
 * to avoid deadlock) and verifies sufficient funds inside the lock window.
 * Returns `{ ok: true, newBalance }` on success or `{ ok: false, reason }` on failure.
 * Reasons: "insufficient" | "economy_unavailable" | "self_transfer".
 */
export async function transferBalance(fromId, toId, amount, tax = 0, type = "transfer", details = "") {
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (fromId === toId) return { ok: false, reason: "self_transfer" };
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(tax) || tax < 0) {
    return { ok: false, reason: "invalid_amount" };
  }

  const [first, second] = fromId < toId ? [fromId, toId] : [toId, fromId];
  return withEconLock(first, () =>
    withEconLock(second, async () => {
      const sender = await getBalance(fromId);
      const total = Math.floor(amount) + Math.floor(tax);
      if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: "invalid_amount" };
      if (sender.balance < total) {
        return { ok: false, reason: "insufficient", balance: sender.balance, required: total };
      }
      let newSenderBalance;
      try {
        newSenderBalance = await _updateBalanceUnsafe(fromId, -total, type, details || `transfer to ${toId}`);
      } catch (err) {
        return { ok: false, reason: err?.code === "insufficient_balance" ? "insufficient" : err?.message || "debit_failed" };
      }
      try {
        await _updateBalanceUnsafe(toId, Math.floor(amount), "receive", details || `transfer from ${fromId}`);
      } catch (err) {
        // Best-effort rollback — refund sender so coins aren't lost.
        try { await _updateBalanceUnsafe(fromId, total, "transfer_refund", `credit to ${toId} failed`); } catch (rollbackErr) {
          log(`[DB] transferBalance rollback failed for ${fromId}: ${rollbackErr.message} — manual reconciliation needed`);
        }
        return { ok: false, reason: err?.message || "credit_failed" };
      }
      return { ok: true, newBalance: newSenderBalance, sent: amount, tax };
    })
  );
}

export async function claimDaily(userId) {
  if (!supabase) return { success: false, offline: true };
  // Durable store gone dark — refuse rather than stamp a cooldown + credit that
  // can't be flushed. Surfaced to callers as the transient claim_failed message.
  if (!isPersistenceHealthy()) return { success: false, error: "claim_failed" };
  // Serialize the whole read-check-write sequence so rapid /daily spams can't
  // double-claim between the cooldown check and the cache/DB update.
  return withEconLock(userId, async () => {
    const current = await getBalance(userId);
    const now = new Date();
    const lastDaily = current.last_daily ? new Date(current.last_daily) : null;

    if (lastDaily) {
      const hoursSince = (now - lastDaily) / 3_600_000;
      if (hoursSince < 20) {
        const hoursLeft = Math.ceil(20 - hoursSince);
        return { success: false, hoursLeft };
      }
      if (hoursSince > 48) current.daily_streak = 0;
    }

    const streak = (current.daily_streak || 0) + 1;
    const base = 50;
    const bonus = Math.min(streak * 10, 150);
    const coins = base + bonus;

    // Fail-closed ordering: stamp the cooldown (last_daily + streak) and AWAIT
    // it BEFORE crediting. If the process crashes between stamp and credit the
    // user merely loses one claim's coins (recoverable) rather than being able
    // to re-claim forever. If the stamp write itself fails, abort WITHOUT
    // crediting. The durable fix is the atomic claim RPC (migration 003).
    try {
      const { error: stampErr } = await supabase.from("eris_economy")
        .update({ daily_streak: streak, last_daily: now.toISOString() })
        .eq("user_id", userId);
      if (stampErr) throw new Error(stampErr.message);
      if (_economyCache[userId]) {
        _economyCache[userId].daily_streak = streak;
        _economyCache[userId].last_daily = now.toISOString();
      }
    } catch (e) {
      log(`[DB] claimDaily stamp failed (no credit): ${e.message}`);
      return { success: false, error: "claim_failed" };
    }

    // Credit via the unsafe helper (lock already held)
    const newBalance = await _updateBalanceUnsafe(userId, coins, "daily", `streak:${streak}`);

    return { success: true, coins, streak, bonus, newBalance };
  });
}

export async function getLeaderboard(limit = 10) {
  if (!supabase) {
    return Object.entries(_economyCache)
      .map(([uid, e]) => ({ user_id: uid, balance: e.balance }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, limit);
  }
  const { data: rows } = await supabase.from("eris_economy").select("user_id, balance").order("balance", { ascending: false }).limit(limit);
  return rows || [];
}

// ─── Multi-axis leaderboards ───────────────────────────────────────────────
// Supported axes: balance (default), earned, gambled, streak, prestige,
// stolen (rob_success total), lost. The eris_economy schema already has all
// these columns, we just weren't exposing them.
const LEADERBOARD_AXES = {
  balance:  { column: "balance",         label: "💰 Wealthiest",          suffix: "coins" },
  earned:   { column: "total_earned",    label: "📈 Most Earned",         suffix: "coins" },
  gambled:  { column: "total_gambled",   label: "🎰 Biggest Gambler",     suffix: "coins" },
  streak:   { column: "daily_streak",    label: "🔥 Longest Streak",      suffix: "days" },
  prestige: { column: "prestige_level",  label: "⭐ Top Prestige",        suffix: "lv" },
  stolen:   { column: "total_stolen",    label: "🥷 Best Thief",          suffix: "coins" },
  lost:     { column: "total_lost",      label: "💸 Most Lost",           suffix: "coins" },
};

export function getLeaderboardAxes() {
  return Object.keys(LEADERBOARD_AXES);
}

export function getLeaderboardAxisInfo(axis) {
  return LEADERBOARD_AXES[axis] || null;
}

export async function getLeaderboardByAxis(axis, limit = 10) {
  const info = LEADERBOARD_AXES[axis];
  if (!info) return { error: `unknown axis "${axis}". try: ${Object.keys(LEADERBOARD_AXES).join(", ")}` };

  if (!supabase) {
    // In-memory fallback — only works for the balance axis since other cols
    // live only in Supabase. Return empty for everything else.
    if (axis !== "balance") return { axis, label: info.label, suffix: info.suffix, rows: [] };
    const rows = Object.entries(_economyCache)
      .map(([uid, e]) => ({ user_id: uid, value: e.balance }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
    return { axis, label: info.label, suffix: info.suffix, rows };
  }

  const { data, error } = await supabase
    .from("eris_economy")
    .select(`user_id, ${info.column}`)
    .order(info.column, { ascending: false })
    // Stable tie-breaker — without this, Postgres returns ties in arbitrary
    // order so positions flicker between refreshes.
    .order("user_id", { ascending: true })
    .limit(limit);
  if (error) return { error: error.message };
  const rows = (data || [])
    .map((r) => ({ user_id: r.user_id, value: r[info.column] ?? 0 }))
    .filter((r) => r.value > 0); // hide users with no activity on this axis
  return { axis, label: info.label, suffix: info.suffix, rows };
}

export async function logTransaction(userId, type, amount, balanceAfter, details = "") {
  if (!supabase) return;
  try { await supabase.from("eris_transactions").insert({ user_id: userId, type, amount, balance_after: balanceAfter, details }); } catch (e) { log(`[DB] ${e.message}`); }
}

export function checkEarnCooldown(userId) {
  const last = _earnCooldown.get(userId) || 0;
  if (Date.now() - last < 60_000) return false;
  _earnCooldown.set(userId, Date.now());
  return true;
}

export async function earnMessageCoins(userId) {
  if (!checkEarnCooldown(userId)) return 0;
  const coins = 1 + Math.floor(Math.random() * 3); // 1-3 coins
  await updateBalance(userId, coins, "message_earn", "chatting");
  return coins;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME STATE — per-user game stats (W/L, streaks, totals), in-memory active
// game sessions (auto-expiring), pending duels, anonymous confessions queue,
// trivia stats, and per-user AI preferences.
// ═══════════════════════════════════════════════════════════════════════════
// ─── GAME STATS ─────────────────────────────────────────────────────────────

export async function getGameStats(userId, gameType) {
  if (!supabase) return { wins: 0, losses: 0, current_streak: 0, best_streak: 0, total_wagered: 0, total_won: 0 };
  const { data: row } = await supabase.from("eris_game_stats").select("*").eq("user_id", userId).eq("game_type", gameType).single();
  return row || { wins: 0, losses: 0, current_streak: 0, best_streak: 0, total_wagered: 0, total_won: 0 };
}

export async function recordGameResult(userId, gameType, won, wagered = 0, payout = 0) {
  if (!supabase) return;
  const stats = await getGameStats(userId, gameType);
  const newStreak = won ? (stats.current_streak > 0 ? stats.current_streak + 1 : 1) : (stats.current_streak < 0 ? stats.current_streak - 1 : -1);
  const bestStreak = Math.max(stats.best_streak || 0, won ? newStreak : 0);
  try {
    await supabase.from("eris_game_stats").upsert({
      user_id: userId, game_type: gameType,
      wins: (stats.wins || 0) + (won ? 1 : 0),
      losses: (stats.losses || 0) + (won ? 0 : 1),
      current_streak: newStreak, best_streak: bestStreak,
      total_wagered: (stats.total_wagered || 0) + wagered,
      total_won: (stats.total_won || 0) + payout,
    });
  } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── ACTIVE GAMES ───────────────────────────────────────────────────────────

const _activeGames = new Map(); // "channelId:userId:gameType" → state

export function saveActiveGame(channelId, userId, gameType, gameState, stake = 0) {
  _activeGames.set(`${channelId}:${userId}:${gameType}`, { gameState, stake, createdAt: Date.now() });
}

export function getActiveGame(channelId, userId, gameType) {
  const key = `${channelId}:${userId}:${gameType}`;
  const game = _activeGames.get(key);
  if (!game) return null;
  // Auto-expire stale games (5 min) — prevents permanently stuck state
  if (Date.now() - game.createdAt > 300_000) {
    _activeGames.delete(key);
    return null;
  }
  return game;
}

export function deleteActiveGame(channelId, userId, gameType) {
  _activeGames.delete(`${channelId}:${userId}:${gameType}`);
}

export function cleanupExpiredGames(maxAgeMs = 180_000) {
  const now = Date.now();
  const expired = [];
  for (const [key, game] of _activeGames) {
    if (now - game.createdAt > maxAgeMs) {
      // key format: "channelId:userId:gameType"
      const [channelId, userId, gameType] = key.split(":");
      expired.push({ channelId, userId, gameType, stake: game.stake });
      _activeGames.delete(key);
    }
  }
  return expired;
}

// ─── DUELS ──────────────────────────────────────────────────────────────────

const _pendingDuels = new Map(); // "channelId:targetId" → duel data

export function createDuel(challengerId, targetId, channelId, stake = 0) {
  const key = `${channelId}:${targetId}`;
  if (_pendingDuels.has(key)) return { success: false, error: "this user already has a pending duel here" };
  _pendingDuels.set(key, { challengerId, targetId, channelId, stake, createdAt: Date.now() });
  return { success: true };
}

export function getPendingDuel(channelId, targetId) {
  return _pendingDuels.get(`${channelId}:${targetId}`) || null;
}

export function resolveDuel(channelId, targetId) {
  const key = `${channelId}:${targetId}`;
  const duel = _pendingDuels.get(key);
  _pendingDuels.delete(key);
  return duel;
}

export function cleanupExpiredDuels(maxAgeMs = 300_000) {
  const now = Date.now();
  for (const [key, duel] of _pendingDuels) {
    if (now - duel.createdAt > maxAgeMs) _pendingDuels.delete(key);
  }
}

// ─── CONFESSIONS ────────────────────────────────────────────────────────────

let _confessionCounter = 0;
const _unpostedConfessions = [];

export async function saveConfession(userId, guildId, channelId, text) {
  if (!text || text.length > 2000) return false; // Discord embed cap + sanity
  _unpostedConfessions.push({ userId, guildId, channelId, text: text.slice(0, 2000), createdAt: Date.now() });
  if (supabase) {
    try { await supabase.from("eris_confessions").insert({ user_id: userId, guild_id: guildId, channel_id: channelId, confession_text: text }); } catch (e) { log(`[DB] ${e.message}`); }
  }
  return true;
}

export function getUnpostedConfessions() {
  return _unpostedConfessions.splice(0); // drain and return
}

export function getConfessionNumber() {
  return ++_confessionCounter;
}

// ─── TRIVIA STATS ───────────────────────────────────────────────────────────

export async function getTriviaStats(userId) {
  if (!supabase) return { correct: 0, wrong: 0, current_streak: 0, best_streak: 0 };
  const { data: row } = await supabase.from("eris_trivia").select("*").eq("user_id", userId).single();
  return row || { correct: 0, wrong: 0, current_streak: 0, best_streak: 0 };
}

export async function recordTriviaResult(userId, correct) {
  if (!supabase) return;
  const stats = await getTriviaStats(userId);
  const newStreak = correct ? (stats.current_streak > 0 ? stats.current_streak + 1 : 1) : 0;
  try {
    await supabase.from("eris_trivia").upsert({
      user_id: userId,
      correct: (stats.correct || 0) + (correct ? 1 : 0),
      wrong: (stats.wrong || 0) + (correct ? 0 : 1),
      current_streak: newStreak,
      best_streak: Math.max(stats.best_streak || 0, newStreak),
    });
  } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── USER PREFERENCES (for smarter AI) ──────────────────────────────────────

export async function getUserPreferences(userId) {
  if (!supabase) return { topics: [], sentiment_avg: 0, interaction_style: null };
  const { data: row } = await supabase.from("eris_user_preferences").select("*").eq("user_id", userId).single();
  return row || { topics: [], sentiment_avg: 0, interaction_style: null };
}

export async function updateUserPreferences(userId, updates) {
  if (!supabase) return;
  try { await supabase.from("eris_user_preferences").upsert({ user_id: userId, ...updates, updated_at: new Date().toISOString() }); } catch (e) { log(`[DB] ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHOP, INVENTORY, ACHIEVEMENTS — shop catalog with atomic stock decrement /
// increment (optimistic locking handles concurrent buyers), per-user item
// inventory, and the unique-key achievements table.
// ═══════════════════════════════════════════════════════════════════════════
// ─── SHOP ───────────────────────────────────────────────────────────────────

export async function getShopItems(guildId) {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_shop_items").select("*").or(`guild_id.eq.${guildId},guild_id.is.null`).order("price");
  return data || [];
}

export async function addShopItem(guildId, item) {
  if (!supabase) return;
  try { await supabase.from("eris_shop_items").insert({ guild_id: guildId, ...item }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function decrementShopStock(itemId) {
  // Back-compat wrapper — forwards to the atomic version and ignores the result.
  await tryDecrementShopStock(itemId);
}

/**
 * Atomically decrement shop stock iff it's still > 0. Uses optimistic locking:
 * reads the current stock, then conditionally updates only if the value hasn't
 * changed. Two parallel buyers for the last copy can't both succeed — one of
 * them gets { ok: false, reason: "stock_changed" } and the caller must refund.
 * Returns { ok: true, remaining } or { ok: false, reason }.
 */
export async function tryDecrementShopStock(itemId) {
  if (!supabase) return { ok: false, reason: "offline" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: row, error: readErr } = await supabase
        .from("eris_shop_items")
        .select("limited_stock")
        .eq("id", itemId)
        .single();
      if (readErr) return { ok: false, reason: readErr.message };
      if (row?.limited_stock == null) return { ok: true, remaining: null }; // unlimited
      if (row.limited_stock <= 0) return { ok: false, reason: "sold_out" };

      const newStock = row.limited_stock - 1;
      const { data: updated, error: writeErr } = await supabase
        .from("eris_shop_items")
        .update({ limited_stock: newStock })
        .eq("id", itemId)
        .eq("limited_stock", row.limited_stock) // optimistic — only if still matches
        .select("id");
      if (writeErr) return { ok: false, reason: writeErr.message };
      if (updated?.length) return { ok: true, remaining: newStock };
      // Conflict — someone else bought between our read and write. Retry.
    } catch (e) { log(`[DB] tryDecrementShopStock: ${e.message}`); }
  }
  return { ok: false, reason: "stock_changed_retry_exhausted" };
}

/**
 * Atomically increment shop stock by 1. Used when a purchase fails after
 * stock was reserved — previously we wrote back a stale pre-decrement
 * value which could over-restore if other buyers moved the number in between.
 */
export async function tryIncrementShopStock(itemId) {
  if (!supabase) return { ok: false, reason: "offline" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: row, error: readErr } = await supabase
        .from("eris_shop_items")
        .select("limited_stock")
        .eq("id", itemId)
        .single();
      if (readErr) return { ok: false, reason: readErr.message };
      if (row?.limited_stock == null) return { ok: true, remaining: null }; // unlimited — nothing to refund

      const newStock = row.limited_stock + 1;
      const { data: updated, error: writeErr } = await supabase
        .from("eris_shop_items")
        .update({ limited_stock: newStock })
        .eq("id", itemId)
        .eq("limited_stock", row.limited_stock)
        .select("id");
      if (writeErr) return { ok: false, reason: writeErr.message };
      if (updated?.length) return { ok: true, remaining: newStock };
    } catch (e) { log(`[DB] tryIncrementShopStock: ${e.message}`); }
  }
  return { ok: false, reason: "stock_changed_retry_exhausted" };
}

// ─── INVENTORY ──────────────────────────────────────────────────────────────

export async function getInventory(userId) {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_inventory").select("*").eq("user_id", userId).order("acquired_at", { ascending: false });
  return data || [];
}

export async function addToInventory(userId, itemName, itemType) {
  if (!supabase) return;
  try { await supabase.from("eris_inventory").insert({ user_id: userId, item_name: itemName, item_type: itemType }); } catch (e) { log(`[DB] ${e.message}`); }
}

// Removes one matching row and returns its original item_type (or null) so
// callers that re-grant the item later — e.g. auction escrow refunds — can
// restore it under the same inventory category instead of a lifecycle string.
export async function removeFromInventory(userId, itemName) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_inventory").select("id, item_type").eq("user_id", userId).eq("item_name", itemName).limit(1).single();
    if (data) {
      await supabase.from("eris_inventory").delete().eq("id", data.id);
      return data.item_type ?? null;
    }
  } catch (e) { log(`[DB] ${e.message}`); }
  return null;
}

export async function hasItem(userId, itemName) {
  if (!supabase) return false;
  const { data } = await supabase.from("eris_inventory").select("id").eq("user_id", userId).eq("item_name", itemName).limit(1);
  return data?.length > 0;
}

// ─── ACHIEVEMENTS ───────────────────────────────────────────────────────────

export async function unlockAchievement(userId, key) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("eris_achievements").insert({ user_id: userId, achievement_key: key });
    return !error; // returns false if already unlocked (unique constraint)
  } catch { return false; }
}

export async function getUnlockedAchievements(userId) {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_achievements").select("achievement_key, unlocked_at").eq("user_id", userId);
  return data || [];
}

export async function hasAchievement(userId, key) {
  if (!supabase) return false;
  const { data } = await supabase.from("eris_achievements").select("id").eq("user_id", userId).eq("achievement_key", key).limit(1);
  return data?.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOANS, BOUNTIES, DAILY CHALLENGES — short-term coin loans with overdue
// sweep, per-guild bounties on users, and the daily server challenge with
// per-user completion tracking.
// ═══════════════════════════════════════════════════════════════════════════
// ─── LOANS ──────────────────────────────────────────────────────────────────

export async function createLoan(userId, amount, interestRate, dueAt) {
  if (!supabase) return;
  try { await supabase.from("eris_loans").insert({ user_id: userId, amount, interest_rate: interestRate, due_at: dueAt }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getActiveLoan(userId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_loans").select("*").eq("user_id", userId).eq("status", "active").limit(1).single();
  return data;
}

export async function closeLoan(loanId, status = "paid") {
  if (!supabase) return;
  try { await supabase.from("eris_loans").update({ status }).eq("id", loanId); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getOverdueLoans() {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_loans").select("*").eq("status", "active").lt("due_at", new Date().toISOString());
  return data || [];
}

// ─── BOUNTIES ───────────────────────────────────────────────────────────────

export async function createBounty(targetId, placedBy, amount, guildId) {
  if (!supabase) return;
  try { await supabase.from("eris_bounties").insert({ target_user_id: targetId, placed_by: placedBy, amount, guild_id: guildId }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getActiveBounties(guildId) {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_bounties").select("*").eq("guild_id", guildId).eq("status", "active").order("amount", { ascending: false });
  return data || [];
}

export async function getBountyOnUser(userId, guildId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_bounties").select("*").eq("target_user_id", userId).eq("guild_id", guildId).eq("status", "active").limit(1).single();
  return data;
}

export async function claimBounty(bountyId) {
  if (!supabase) return;
  try { await supabase.from("eris_bounties").update({ status: "claimed" }).eq("id", bountyId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── DAILY CHALLENGES ───────────────────────────────────────────────────────

export async function getDailyChallenge(guildId, date) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_daily_challenges").select("*").eq("guild_id", guildId).eq("date", date).limit(1).single();
  return data;
}

export async function createDailyChallenge(guildId, type, target, reward, date) {
  if (!supabase) return;
  try { await supabase.from("eris_daily_challenges").insert({ guild_id: guildId, challenge_type: type, challenge_target: target, reward, date }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function completeDailyChallenge(challengeId, userId) {
  if (!supabase) return;
  // Wrap the read-modify-write in a per-challenge lock so two concurrent
  // completions on the same challenge can't both read the same completed_by
  // array, both push their id, and the second write clobber the first
  // (silently dropping the first user's id from the completion list).
  // withUserLock is just a string-keyed mutex — challengeId works fine as the
  // key. Also do an optimistic post-write verification as defense-in-depth
  // for the multi-instance case where the in-process lock can't help.
  return withUserLock(challengeId, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await supabase.from("eris_daily_challenges").select("completed_by").eq("id", challengeId).single();
        const completed = data?.completed_by || [];
        if (completed.includes(userId)) return; // already completed — no-op
        const next = [...completed, userId];
        await supabase.from("eris_daily_challenges").update({ completed_by: next }).eq("id", challengeId);
        // Defense-in-depth: re-read and confirm our id landed. If a racing
        // writer overwrote us (only possible across instances since the
        // lock above serializes within a process), retry once.
        const { data: verify } = await supabase.from("eris_daily_challenges").select("completed_by").eq("id", challengeId).single();
        if ((verify?.completed_by || []).includes(userId)) return;
      } catch (e) { log(`[DB] ${e.message}`); return; }
    }
  });
}

// The OLD eris_stocks / eris_portfolios table accessors used to live here
// (getAllStocks / getStock / updateStockPrice / buyStock / sellStock /
// getHolding / getPortfolio). They were dead after the stock market moved
// to the in-memory GBM simulation in ai/stockMarket.js (persisted under
// bot_data.eris_stocks). Removed to prevent future code from accidentally
// writing to the abandoned tables.

// ═══════════════════════════════════════════════════════════════════════════
// BOSS BATTLES, PETS, TERRITORIES — server-wide boss fights with multi-phase
// HP and shared loot, per-user pets with hunger/mood decay over time, and
// channel-claimed territories that generate passive coin income.
// ═══════════════════════════════════════════════════════════════════════════
// ─── BOSS BATTLES ───────────────────────────────────────────────────────────

export async function createBossBattle(guildId, bossName, hp, expiresAt) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_boss_battles").insert({ guild_id: guildId, boss_name: bossName, boss_hp: hp, max_hp: hp, expires_at: expiresAt }).select().single();
    return data;
  } catch { return null; }
}

export async function getActiveBoss(guildId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_boss_battles").select("*").eq("guild_id", guildId).gt("boss_hp", 0).order("created_at", { ascending: false }).limit(1).single();
  return data;
}

export async function spawnBoss(guildId, bossName, bossEmoji, hp, phases, lootMultiplier) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_boss_battles").insert({
      guild_id: guildId,
      boss_name: bossName,
      boss_emoji: bossEmoji,
      boss_hp: hp,
      max_hp: hp,
      participants: {},
      phase: 1,
      loot_multiplier: lootMultiplier,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), // 1 hour
      created_at: new Date().toISOString(),
    }).select().single();
    return data;
  } catch { return null; }
}

export async function damageBoss(bossId, userId, damage) {
  if (!supabase) return null;
  try {
    const { data: boss } = await supabase.from("eris_boss_battles").select("*").eq("id", bossId).single();
    if (!boss) return null;
    if (boss.boss_hp <= 0) return { ...boss, defeated: false, alreadyDead: true }; // Already killed by someone else
    const newHp = Math.max(0, boss.boss_hp - damage);
    const participants = boss.participants || {};
    participants[userId] = (participants[userId] || 0) + damage;
    const phase = newHp <= 0 ? 0 : newHp <= boss.max_hp * 0.25 ? 3 : newHp <= boss.max_hp * 0.5 ? 2 : 1;
    await supabase.from("eris_boss_battles").update({ boss_hp: newHp, participants, phase }).eq("id", bossId);
    return { ...boss, boss_hp: newHp, participants, phase, defeated: newHp <= 0 };
  } catch { return null; }
}

// ─── PETS ───────────────────────────────────────────────────────────────────

/**
 * Apply time-based hunger/mood decay to a pet snapshot. Non-destructive —
 * returns a new object with decayed values but doesn't write back. Graceful
 * when `last_fed` is missing from the row (old pets predating this feature).
 *
 * Rules:
 *   - Hunger drops 2/hour (full → starving in ~50h)
 *   - Mood drops 1/hour once hunger is below 30 (hangry mechanic)
 *   - Mood recovers 0.5/hour while hunger is above 50
 */
function _applyHungerDecay(pet) {
  if (!pet) return pet;
  const now = Date.now();
  const lastFedRaw = pet.last_fed ? new Date(pet.last_fed).getTime() : now;
  // Clamp future timestamps (clock skew / tampering) so a user can't game
  // decay by pointing last_fed at 2099.
  const lastFedTs = Number.isFinite(lastFedRaw) ? Math.min(lastFedRaw, now) : now;
  const hoursSince = Math.max(0, (now - lastFedTs) / 3_600_000);
  if (hoursSince <= 0) return pet;

  const out = { ...pet };
  const baseHunger = pet.hunger ?? 100;
  out.hunger = Math.max(0, Math.floor(baseHunger - hoursSince * 2));

  // Mood drifts based on hunger state. Use <= 30 / >= 50 to avoid the
  // off-by-one where a pet fed to exactly 30 never escapes the hangry zone.
  const baseMood = pet.mood ?? 100;
  if (out.hunger <= 30) {
    out.mood = Math.max(0, Math.floor(baseMood - hoursSince * 1));
  } else if (baseHunger >= 50) {
    out.mood = Math.min(100, Math.floor(baseMood + hoursSince * 0.5));
  } else {
    out.mood = baseMood;
  }
  return out;
}

export async function getPet(userId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_pets").select("*").eq("user_id", userId).single();
  return _applyHungerDecay(data);
}

/** Raw fetch without decay — use sparingly (recordPetBattle / trainPet etc) */
export async function getPetRaw(userId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_pets").select("*").eq("user_id", userId).single();
  return data;
}

export async function createPet(userId, name, species) {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("eris_pets")
      .insert({ user_id: userId, name, species, last_fed: new Date().toISOString() })
      .select()
      .single();
    return data;
  } catch { return null; }
}

export async function updatePet(userId, updates) {
  if (!supabase) return;
  try { await supabase.from("eris_pets").update(updates).eq("user_id", userId); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function feedPet(userId) {
  if (!supabase) return;
  return withEconLock(userId, async () => {
    // Read RAW so we add to the decayed-forward value but reset last_fed to now.
    const pet = await getPetRaw(userId);
    if (!pet) return null;
    const decayed = _applyHungerDecay(pet);
    const newHunger = Math.min(100, decayed.hunger + 30);
    const newMood = Math.min(100, decayed.mood + 10);
    const newXp = (pet.xp ?? 0) + 5;
    await updatePet(userId, {
      hunger: newHunger,
      mood: newMood,
      xp: newXp,
      last_fed: new Date().toISOString(),
    });
    return { hunger: newHunger, mood: newMood, xp: newXp };
  });
}

// ─── TERRITORIES ────────────────────────────────────────────────────────────

export async function getTerritory(channelId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_territories").select("*").eq("channel_id", channelId).single();
  return data;
}

export async function claimTerritory(guildId, channelId, ownerId) {
  if (!supabase) return;
  try {
    await supabase.from("eris_territories").upsert({ guild_id: guildId, channel_id: channelId, owner_id: ownerId, claimed_at: new Date().toISOString(), last_collected: new Date().toISOString() });
  } catch (e) { log(`[DB] ${e.message}`); }
}

export async function getTerritories(guildId) {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_territories").select("*").eq("guild_id", guildId).not("owner_id", "is", null);
  return data || [];
}

export async function collectTerritoryIncome(territoryId, amount) {
  if (!supabase) return;
  try { await supabase.from("eris_territories").update({ last_collected: new Date().toISOString() }).eq("id", territoryId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// HEISTS, AUCTIONS, ROAST BATTLES — multi-participant heists (per-heist locks
// prevent join races), timed item auctions with bid escalation, and 1v1 roast
// battles with chat-vote resolution.
// ═══════════════════════════════════════════════════════════════════════════
// ─── HEISTS ─────────────────────────────────────────────────────────────────

export async function createHeist(guildId, channelId, organizerId, targetId) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_heists").insert({ guild_id: guildId, channel_id: channelId, organizer_id: organizerId, target_user_id: targetId, participants: [organizerId] }).select().single();
    return data;
  } catch { return null; }
}

export async function getActiveHeist(guildId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_heists").select("*").eq("guild_id", guildId).eq("status", "recruiting").order("created_at", { ascending: false }).limit(1).single();
  return data;
}

// Per-heist in-memory locks — prevents two parallel /heist join calls from
// both reading the same participants array and each push()ing independently,
// which would either duplicate an entry OR lose one depending on write order.
const _heistLocks = new Map();
async function _withHeistLock(heistId, fn) {
  const prev = _heistLocks.get(heistId) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _heistLocks.set(heistId, current);
  try { return await current; } finally {
    if (_heistLocks.get(heistId) === current) _heistLocks.delete(heistId);
  }
}

export async function joinHeist(heistId, userId) {
  if (!supabase) return;
  return _withHeistLock(heistId, async () => {
    try {
      // Re-read inside the lock so another concurrent join that already
      // committed is visible here.
      const { data } = await supabase.from("eris_heists").select("participants").eq("id", heistId).single();
      const parts = data?.participants || [];
      if (parts.includes(userId)) return; // already joined — no-op
      parts.push(userId);
      await supabase.from("eris_heists").update({ participants: parts }).eq("id", heistId);
    } catch (e) { log(`[DB] joinHeist: ${e.message}`); }
  });
}

export async function resolveHeist(heistId, status, loot = 0) {
  if (!supabase) return;
  try { await supabase.from("eris_heists").update({ status, loot }).eq("id", heistId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── AUCTIONS ───────────────────────────────────────────────────────────────

export async function createAuction(sellerId, itemName, startingPrice, guildId, durationMs = 3600_000) {
  if (!supabase) return null;
  try {
    // Escrow the listed item out of the seller's inventory at list time. Without
    // this the seller keeps a copy while settlement grants another to the
    // winner, duping the item. The item is returned to the winner at settlement
    // (events/ready.js) or refunded to the seller if the auction expires with no
    // bids (closeExpiredAuctions). Refuse to list an item the seller doesn't own.
    if (!(await hasItem(sellerId, itemName))) return null;
    // Capture the item's original category as we escrow it out, so refunds (here
    // or at no-bid expiry) restore it under its real type rather than a lifecycle
    // string. Fall back to "auction" if the row carried no type.
    const itemType = (await removeFromInventory(sellerId, itemName)) || "auction";
    const endsAt = new Date(Date.now() + durationMs).toISOString();
    const baseRow = { seller_id: sellerId, item_name: itemName, starting_price: startingPrice, current_bid: startingPrice, ends_at: endsAt, guild_id: guildId };
    // Persist item_type on the row (migration 005) so closeExpiredAuctions can
    // round-trip it on a no-bid refund. If that column doesn't exist yet (migration
    // unapplied), PostgREST rejects the column — retry without it so listing still
    // works; the no-bid refund then falls back to "auction" as before.
    let { data, error } = await supabase.from("eris_auctions").insert({ ...baseRow, item_type: itemType }).select().single();
    if (error && /item_type/.test(error.message || "")) {
      ({ data, error } = await supabase.from("eris_auctions").insert(baseRow).select().single());
    }
    if (error || !data) {
      // Listing row never landed — give the escrowed item back under its original
      // type so it isn't lost or re-grouped under the wrong inventory category.
      await addToInventory(sellerId, itemName, itemType);
      return null;
    }
    return data;
  } catch { return null; }
}

export async function getActiveAuctions(guildId) {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_auctions").select("*").eq("guild_id", guildId).eq("status", "active").order("ends_at");
  return data || [];
}

// Per-auction in-memory locks — prevents two parallel /bid calls from both
// reading the same current_bid, both passing amount > current_bid, and the
// second update silently clobbering the first (losing-bidder coins debited
// or the higher bid silently lost). Mirrors _withHeistLock above.
const _auctionLocks = new Map();
async function _withAuctionLock(auctionId, fn) {
  const prev = _auctionLocks.get(auctionId) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _auctionLocks.set(auctionId, current);
  try { return await current; } finally {
    if (_auctionLocks.get(auctionId) === current) _auctionLocks.delete(auctionId);
  }
}

export async function bidOnAuction(auctionId, bidderId, amount) {
  if (!supabase) return false;
  return _withAuctionLock(auctionId, async () => {
    // Up to 2 attempts: if the optimistic-concurrency .eq("current_bid", ...)
    // matches zero rows (some other writer slipped in between read and write,
    // e.g. across instances where the in-process lock can't help), re-read
    // and try once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await supabase.from("eris_auctions").select("*").eq("id", auctionId).single();
        if (!data || data.status !== "active" || amount <= data.current_bid) return false;
        const lastSeen = data.current_bid;
        const prevBidderId = data.current_bidder_id || null;

        // Escrow-on-bid: take the bid amount from the new bidder up front so
        // settlement just hands the already-held coins to the seller — no coins
        // are minted. If the bidder can't pay, reject the bid.
        const escrow = await tryDeductBalance(bidderId, amount, "auction_bid", `bid on ${auctionId}`);
        if (!escrow.ok) return false;

        // Defensive optimistic-concurrency: only update if current_bid is
        // still what we just read. If a concurrent writer changed it, the
        // .eq() filter matches zero rows and the update is a no-op — refund the
        // escrow and retry the read.
        const { data: updated } = await supabase
          .from("eris_auctions")
          .update({ current_bid: amount, current_bidder_id: bidderId })
          .eq("id", auctionId)
          .eq("current_bid", lastSeen)
          .select();
        if (updated && updated.length > 0) {
          // We're now the high bidder — refund the previous escrow. The starting
          // price has no escrowed bidder (current_bidder_id is null on create),
          // so only a real previous bidder gets refunded. This INCLUDES the same
          // bidder raising their own bid: we just escrowed the full new `amount`
          // on top of their already-held `lastSeen`, so refunding `lastSeen` to
          // them leaves their total escrow == their current bid (no over-pay).
          if (prevBidderId && lastSeen > 0) {
            try { await updateBalance(prevBidderId, lastSeen, "auction_refund", `outbid on ${auctionId}`); }
            catch (e) { log(`[DB] bidOnAuction refund failed for ${prevBidderId}: ${e.message} — manual reconciliation needed`); }
          }
          return true;
        }
        // Optimistic check failed — refund our escrow and loop to retry once.
        try { await updateBalance(bidderId, amount, "auction_refund", `bid race lost on ${auctionId}`); }
        catch (e) { log(`[DB] bidOnAuction escrow refund failed for ${bidderId}: ${e.message} — manual reconciliation needed`); }
      } catch { return false; }
    }
    return false;
  });
}

export async function closeExpiredAuctions() {
  if (!supabase) return [];
  const { data } = await supabase.from("eris_auctions").select("*").eq("status", "active").lt("ends_at", new Date().toISOString());
  if (!data?.length) return [];
  for (const auction of data) {
    try { await supabase.from("eris_auctions").update({ status: "closed" }).eq("id", auction.id); } catch (e) { log(`[DB] ${e.message}`); }
    // No winning bidder → the item was escrowed out at createAuction time, so
    // return it to the seller. Auctions that sold are settled by the winner-grant
    // path in events/ready.js (the item the seller escrowed becomes the winner's).
    if (!(auction.current_bidder_id && auction.current_bid > 0)) {
      // Restore under the item's original category (captured at list time on the
      // row). Falls back to "auction" if the column is absent / unset so the item
      // is never grouped under a lifecycle string like "auction_unsold".
      try { await addToInventory(auction.seller_id, auction.item_name, auction.item_type || "auction"); }
      catch (e) { log(`[DB] closeExpiredAuctions refund failed for ${auction.seller_id}: ${e.message}`); }
    }
  }
  return data;
}

// ─── ROAST BATTLES ──────────────────────────────────────────────────────────

export async function createRoastBattle(guildId, channelId, player1Id, player2Id) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_roast_battles").insert({ guild_id: guildId, channel_id: channelId, player1_id: player1Id, player2_id: player2Id }).select().single();
    return data;
  } catch { return null; }
}

export async function getPendingRoast(channelId, userId) {
  if (!supabase) return null;
  const { data } = await supabase.from("eris_roast_battles").select("*").eq("channel_id", channelId).eq("player2_id", userId).eq("status", "pending").single();
  return data;
}

export async function updateRoastBattle(roastId, updates) {
  if (!supabase) return;
  try { await supabase.from("eris_roast_battles").update(updates).eq("id", roastId); } catch (e) { log(`[DB] ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// BANKING, PRESTIGE, MARRIAGE, REWARDS — bank vault (capacity grows with
// prestige, 1%/day interest), prestige ladder with capped earn multiplier,
// marriage (cached) and weekly/monthly reward claims with streak bonuses.
// All atomic deposits/withdrawals share the economy lock.
// ═══════════════════════════════════════════════════════════════════════════
// ─── BANKING ───────────────────────────────────────────────────────────────

// LRU + 5min TTL: caps memory (1000 distinct users) and lets out-of-band
// Supabase edits propagate within a bounded window instead of being silently
// shadowed by a permanent in-memory copy.
const _bankCache = new LRUCache(1000, 5 * 60_000);

export async function getBankBalance(userId) {
  const cached = _bankCache.get(userId);
  if (cached) return { ...cached };
  if (!supabase) return { balance: 0, last_interest: null };
  try {
    const { data } = await supabase.from("eris_bank").select("*").eq("user_id", userId).single();
    if (data) { _bankCache.set(userId, data); return { ...data }; }
  } catch (e) { log(`[DB] ${e.message}`); }
  return { balance: 0, last_interest: null };
}

export async function updateBankBalance(userId, delta) {
  const current = await getBankBalance(userId);
  const newBal = Math.max(0, current.balance + delta);
  const row = { user_id: userId, balance: newBal, last_interest: current.last_interest || new Date().toISOString() };
  if (supabase) {
    try { await supabase.from("eris_bank").upsert(row); } catch (e) { log(`[DB] ${e.message}`); }
  }
  _bankCache.set(userId, row);
  return newBal;
}

/**
 * Atomic deduct — verifies sufficient funds INSIDE the per-user lock and
 * only debits if the check passes. Use for button-driven purchases where
 * the balance-check and deduct used to be separate `await` calls, letting
 * two rapid clicks both pass the check before either debit landed.
 * Returns { ok: true, newBalance } or { ok: false, reason }.
 */
export async function tryDeductBalance(userId, amount, type = "deduct", details = "") {
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  return withEconLock(userId, async () => {
    const current = await getBalance(userId);
    if (current.balance < amount) {
      return { ok: false, reason: "insufficient", balance: current.balance, required: amount };
    }
    const newBalance = await _updateBalanceUnsafe(userId, -amount, type, details);
    return { ok: true, newBalance };
  });
}

/**
 * Atomic wallet → bank transfer. Holds the user's economy lock across
 * read-check-debit-credit so parallel bank_deposit calls can't both
 * pass the "wallet has enough" check and double-spend the wallet.
 * Returns { ok, newWalletBalance, newBankBalance } or { ok: false, reason }.
 */
export async function bankDeposit(userId, amount) {
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  return withEconLock(userId, async () => {
    const wallet = await getBalance(userId);
    if (wallet.balance < amount) return { ok: false, reason: "insufficient_wallet", balance: wallet.balance };
    const bank = await getBankBalance(userId);
    const cap = await getBankCapacity(userId);
    if (bank.balance + amount > cap) {
      return { ok: false, reason: "bank_full", bank: bank.balance, capacity: cap, maxDeposit: cap - bank.balance };
    }
    // Deduct the source (wallet) FIRST — it throws on failure, so we never
    // credit the bank against a debit that didn't land. If the bank credit
    // then throws, roll the wallet back so coins are conserved.
    const newWalletBalance = await _updateBalanceUnsafe(userId, -amount, "bank_deposit", "deposited to bank");
    let newBankBalance;
    try {
      newBankBalance = await updateBankBalance(userId, amount);
    } catch (err) {
      try { await _updateBalanceUnsafe(userId, amount, "bank_deposit_refund", "bank credit failed"); } catch (rollbackErr) {
        log(`[DB] bankDeposit rollback failed for ${userId}: ${rollbackErr.message} — manual reconciliation needed`);
      }
      return { ok: false, reason: err?.message || "bank_credit_failed" };
    }
    return { ok: true, newWalletBalance, newBankBalance, capacity: cap };
  });
}

/**
 * Atomic bank → wallet transfer, same safety properties as bankDeposit.
 */
export async function bankWithdraw(userId, amount) {
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  return withEconLock(userId, async () => {
    const bank = await getBankBalance(userId);
    if (bank.balance < amount) return { ok: false, reason: "insufficient_bank", balance: bank.balance };
    // Deduct the source (bank) FIRST, then credit the wallet. If the wallet
    // credit throws, refund the bank so coins are conserved.
    const newBankBalance = await updateBankBalance(userId, -amount);
    let newWalletBalance;
    try {
      newWalletBalance = await _updateBalanceUnsafe(userId, amount, "bank_withdraw", "withdrew from bank");
    } catch (err) {
      try { await updateBankBalance(userId, amount); } catch (rollbackErr) {
        log(`[DB] bankWithdraw rollback failed for ${userId}: ${rollbackErr.message} — manual reconciliation needed`);
      }
      return { ok: false, reason: err?.code === "insufficient_balance" ? "wallet_credit_failed" : err?.message || "wallet_credit_failed" };
    }
    return { ok: true, newWalletBalance, newBankBalance };
  });
}

export async function getBankCapacity(userId) {
  const prestige = await getPrestigeLevel(userId);
  return 5000 + prestige * 2500;
}

export async function applyBankInterest(userId) {
  // Serialize the read-modify-write so two concurrent calls can't both read the
  // same last_interest, both pass the 24h check, and each credit interest —
  // double-crediting (minting) coins. The last_interest stamp inside the lock
  // makes a second call see hoursSince < 24 and short-circuit.
  return withEconLock(userId, async () => {
    const bank = await getBankBalance(userId);
    if (bank.balance <= 0) return 0;
    const last = bank.last_interest ? new Date(bank.last_interest) : new Date();
    const hoursSince = (Date.now() - last.getTime()) / 3_600_000;
    if (hoursSince < 24) return 0;
    const days = Math.floor(hoursSince / 24);
    const interest = Math.floor(bank.balance * 0.01 * days);
    if (interest <= 0) return 0;
    const cap = await getBankCapacity(userId);
    const actualInterest = Math.min(interest, cap - bank.balance);
    if (actualInterest <= 0) return 0;
    await updateBankBalance(userId, actualInterest);
    const updated = await getBankBalance(userId);
    if (supabase) {
      try { await supabase.from("eris_bank").update({ last_interest: new Date().toISOString() }).eq("user_id", userId); } catch (e) { log(`[DB] ${e.message}`); }
    }
    _bankCache.set(userId, { ...updated, last_interest: new Date().toISOString() });
    return actualInterest;
  });
}

// ─── PRESTIGE ──────────────────────────────────────────────────────────────

export async function getPrestigeLevel(userId) {
  const econ = await getBalance(userId);
  return econ.prestige_level || 0;
}

export async function setPrestigeLevel(userId, level) {
  if (!supabase) return;
  try {
    await supabase.from("eris_economy").update({ prestige_level: level }).eq("user_id", userId);
  } catch (e) { log(`[DB] ${e.message}`); }
  if (_economyCache[userId]) _economyCache[userId].prestige_level = level;
}

// Max prestige level applied in the multiplier. Higher raw levels are allowed
// (cosmetic flex) but the earn bonus caps here so runaway compounding doesn't
// turn every earn into an overflow-risking number.
const MAX_PRESTIGE_MULTIPLIER_LEVEL = 50;

export async function getMultipliers(userId) {
  const rawPrestige = await getPrestigeLevel(userId);
  const prestige = Math.min(rawPrestige, MAX_PRESTIGE_MULTIPLIER_LEVEL);
  const marriage = await getMarriage(userId);
  const inv = await getInventory(userId);
  const hasLucky = inv.some(i => i.item_name === "Lucky Charm" && i.active);
  let mult = 1.0;
  const breakdown = [];
  if (prestige > 0) {
    mult += prestige * 0.10;
    const cappedNote = rawPrestige > prestige ? ` (capped, raw lv${rawPrestige})` : "";
    breakdown.push(`prestige lv${prestige}: +${prestige * 10}%${cappedNote}`);
  }
  if (marriage) { mult += 0.10; breakdown.push("married: +10%"); }
  if (hasLucky) { mult += 0.05; breakdown.push("lucky charm: +5%"); }
  return { multiplier: mult, breakdown };
}

// ─── MARRIAGE ──────────────────────────────────────────────────────────────

// LRU + 5min TTL — bounds memory and prevents stale state lingering forever
// after out-of-band DB edits. Writes (createMarriage/deleteMarriage) refresh
// the entry so concurrent readers see the new state immediately.
const _marriageCache = new LRUCache(500, 5 * 60_000);

export async function getMarriage(userId) {
  if (_marriageCache.has(userId)) return _marriageCache.get(userId);
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_marriages").select("*").or(`user1_id.eq.${userId},user2_id.eq.${userId}`).single();
    _marriageCache.set(userId, data || null);
    return data || null;
  } catch {
    _marriageCache.set(userId, null);
    return null;
  }
}

export async function createMarriage(user1Id, user2Id) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_marriages").insert({ user1_id: user1Id, user2_id: user2Id, married_at: new Date().toISOString() }).select().single();
    // Invalidate-then-refresh both partners so any stale "null" cached during
    // a getMarriage() that ran before the insert is replaced.
    _marriageCache.delete(user1Id);
    _marriageCache.delete(user2Id);
    _marriageCache.set(user1Id, data);
    _marriageCache.set(user2Id, data);
    return data;
  } catch { return null; }
}

export async function deleteMarriage(userId) {
  if (!supabase) return false;
  const marriage = await getMarriage(userId);
  if (!marriage) return false;
  try {
    await supabase.from("eris_marriages").delete().eq("id", marriage.id);
    // Invalidate-then-refresh — same rationale as createMarriage. Set to null
    // so subsequent reads short-circuit without hitting Supabase.
    _marriageCache.delete(marriage.user1_id);
    _marriageCache.delete(marriage.user2_id);
    _marriageCache.set(marriage.user1_id, null);
    _marriageCache.set(marriage.user2_id, null);
    return true;
  } catch { return false; }
}

// ─── WEEKLY / MONTHLY REWARDS ──────────────────────────────────────────────

export async function claimWeekly(userId) {
  if (!supabase) return { success: false, offline: true };
  if (!isPersistenceHealthy()) return { success: false, error: "claim_failed" };
  return withEconLock(userId, async () => {
    const econ = await getBalance(userId);
    const now = new Date();
    const lastWeekly = econ.last_weekly ? new Date(econ.last_weekly) : null;
    if (lastWeekly && (now - lastWeekly) < 168 * 3_600_000) {
      const hoursLeft = Math.ceil((168 * 3_600_000 - (now - lastWeekly)) / 3_600_000);
      return { success: false, hoursLeft };
    }
    const streak = lastWeekly && (now - lastWeekly) < 336 * 3_600_000 ? (econ.weekly_streak || 0) + 1 : 1;
    const coins = 500 + streak * 100;
    // Fail-closed ordering: stamp the cooldown BEFORE crediting (see claimDaily).
    try {
      const { error: stampErr } = await supabase.from("eris_economy")
        .update({ last_weekly: now.toISOString(), weekly_streak: streak })
        .eq("user_id", userId);
      if (stampErr) throw new Error(stampErr.message);
      if (_economyCache[userId]) {
        _economyCache[userId].last_weekly = now.toISOString();
        _economyCache[userId].weekly_streak = streak;
      }
    } catch (e) {
      log(`[DB] claimWeekly stamp failed (no credit): ${e.message}`);
      return { success: false, error: "claim_failed" };
    }
    const newBal = await _updateBalanceUnsafe(userId, coins, "weekly", `streak:${streak}`);
    return { success: true, coins, streak, newBalance: newBal };
  });
}

export async function claimMonthly(userId) {
  if (!supabase) return { success: false, offline: true };
  if (!isPersistenceHealthy()) return { success: false, error: "claim_failed" };
  return withEconLock(userId, async () => {
    const econ = await getBalance(userId);
    const now = new Date();
    const lastMonthly = econ.last_monthly ? new Date(econ.last_monthly) : null;
    if (lastMonthly && (now - lastMonthly) < 720 * 3_600_000) {
      const hoursLeft = Math.ceil((720 * 3_600_000 - (now - lastMonthly)) / 3_600_000);
      return { success: false, hoursLeft };
    }
    const streak = lastMonthly && (now - lastMonthly) < 1440 * 3_600_000 ? (econ.monthly_streak || 0) + 1 : 1;
    const coins = 5000 + streak * 1000;
    // Fail-closed ordering: stamp the cooldown BEFORE crediting (see claimDaily).
    try {
      const { error: stampErr } = await supabase.from("eris_economy")
        .update({ last_monthly: now.toISOString(), monthly_streak: streak })
        .eq("user_id", userId);
      if (stampErr) throw new Error(stampErr.message);
      if (_economyCache[userId]) {
        _economyCache[userId].last_monthly = now.toISOString();
        _economyCache[userId].monthly_streak = streak;
      }
    } catch (e) {
      log(`[DB] claimMonthly stamp failed (no credit): ${e.message}`);
      return { success: false, error: "claim_failed" };
    }
    const newBal = await _updateBalanceUnsafe(userId, coins, "monthly", `streak:${streak}`);
    return { success: true, coins, streak, newBalance: newBal };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAFTING, COOLDOWNS, STREAKS, CAREERS — discovered crafting recipes,
// generic per-tool cooldowns with atomic try-acquire, activity streak bonuses
// (rapid same-action multiplier), and the work-tier promotion ladder.
// ═══════════════════════════════════════════════════════════════════════════
// ─── CRAFTING / RECIPES ────────────────────────────────────────────────────

export async function getDiscoveredRecipes(userId) {
  if (!supabase) return [];
  try {
    const { data } = await supabase.from("eris_recipes").select("*").eq("user_id", userId);
    return data || [];
  } catch { return []; }
}

export async function addDiscoveredRecipe(userId, recipeName) {
  if (!supabase) return;
  try {
    await supabase.from("eris_recipes").upsert({ user_id: userId, recipe_name: recipeName, discovered_at: new Date().toISOString() });
  } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── COOLDOWNS (generic) ───────────────────────────────────────────────────

const _cooldowns = new Map(); // "userId:toolName" → timestamp
const _activityStreaks = new Map(); // "userId:activity" → { count, lastTimestamp }
const _careerTiers = new Map(); // userId → { count, tier }

// ─── ACTIVITY STREAKS ────────────────────────────────────────────────────────

export function getActivityStreak(userId, activity) {
  const key = `${userId}:${activity}`;
  const data = _activityStreaks.get(key);
  if (!data) return { count: 0, bonus: 0 };
  // Streak expires if more than 2 minutes past the cooldown window
  const elapsed = Date.now() - data.lastTimestamp;
  if (elapsed > 120_000) {
    _activityStreaks.delete(key);
    return { count: 0, bonus: 0 };
  }
  const bonus = data.count >= 10 ? 0.50 : data.count >= 5 ? 0.25 : data.count >= 3 ? 0.10 : 0;
  return { count: data.count, bonus };
}

export function incrementActivityStreak(userId, activity) {
  const key = `${userId}:${activity}`;
  const existing = _activityStreaks.get(key);
  const elapsed = existing ? Date.now() - existing.lastTimestamp : Infinity;
  // Continue streak if within grace window, otherwise reset
  const count = elapsed <= 120_000 ? (existing.count + 1) : 1;
  _activityStreaks.set(key, { count, lastTimestamp: Date.now() });
  return count;
}

// ─── CAREER TIERS (Work) ────────────────────────────────────────────────────

export function getCareerTier(userId) {
  const data = _careerTiers.get(userId);
  if (!data) return { count: 0, tier: 1, bonus: 0 };
  const tier = Math.min(5, 1 + Math.floor(data.count / 10));
  const bonus = (tier - 1) * 50; // T1: +0, T2: +50, T3: +100, T4: +150, T5: +200
  return { count: data.count, tier, bonus };
}

export function incrementCareerCount(userId) {
  const existing = _careerTiers.get(userId) || { count: 0 };
  existing.count++;
  _careerTiers.set(userId, existing);
  return getCareerTier(userId);
}

export function checkCooldown(userId, toolName, cooldownMs) {
  const key = `${userId}:${toolName}`;
  const last = _cooldowns.get(key) || 0;
  const remaining = cooldownMs - (Date.now() - last);
  if (remaining > 0) return { onCooldown: true, remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) };
  return { onCooldown: false };
}

export function setCooldown(userId, toolName) {
  _cooldowns.set(`${userId}:${toolName}`, Date.now());
}

/**
 * Atomic cooldown acquire — single-step read-check-set. Use this instead of
 * the check/set pair to close the race where two parallel calls both read
 * the old timestamp, both see "not on cooldown", and both pass through.
 * Returns the same shape as checkCooldown so it drops in as a replacement.
 */
export function tryAcquireCooldown(userId, toolName, cooldownMs) {
  const key = `${userId}:${toolName}`;
  const last = _cooldowns.get(key) || 0;
  const now = Date.now();
  const remaining = cooldownMs - (now - last);
  if (remaining > 0) return { onCooldown: true, remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) };
  _cooldowns.set(key, now);
  return { onCooldown: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// PET BATTLES, GUILD SETTINGS, DIRECTIVES, SHUTDOWN — PvP pet stats and
// training, per-server feature toggles + persistent admin directives, and
// the graceful flushAll() shutdown hook that drains the debounced queue.
// ═══════════════════════════════════════════════════════════════════════════
// ─── PET BATTLES ───────────────────────────────────────────────────────────

export async function getPetBattleStats(userId) {
  const pet = await getPet(userId);
  if (!pet) return null;
  return {
    ...pet,
    attack: pet.attack || 5,
    defense: pet.defense || 5,
    speed: pet.speed || 5,
    battles_won: pet.battles_won || 0,
    battles_lost: pet.battles_lost || 0,
  };
}

export async function recordPetBattle(userId, won) {
  // Serialize so two parallel battles by this user don't both read the same
  // pre-battle W/L counts and both write +1, double-counting one result.
  return withEconLock(userId, async () => {
    const pet = await getPet(userId);
    if (!pet) return;
    const updates = {
      xp: (pet.xp || 0) + (won ? 15 : 5),
      battles_won: (pet.battles_won || 0) + (won ? 1 : 0),
      battles_lost: (pet.battles_lost || 0) + (won ? 0 : 1),
    };
    await updatePet(userId, updates);
  });
}

export async function trainPet(userId, stat) {
  const validStats = ["attack", "defense", "speed"];
  if (!validStats.includes(stat)) return null;
  // Wrap read-modify-write so two parallel /pet train calls can't both read
  // the same baseline and each write only their increment.
  return withEconLock(userId, async () => {
    const pet = await getPet(userId);
    if (!pet) return null;
    const gain = 1 + Math.floor(Math.random() * 3); // +1 to +3
    const current = pet[stat] || 5;
    await updatePet(userId, { [stat]: current + gain });
    return { stat, gain, newValue: current + gain };
  });
}

// ─── GUILD SETTINGS (per-server configuration) ─────────────────────────────

function ensureGuild(guildId) {
  if (!data.guild_settings[guildId]) data.guild_settings[guildId] = {};
  return data.guild_settings[guildId];
}

export function getGuildSettings(guildId) {
  return data.guild_settings[guildId] || {};
}

export function setGuildSetting(guildId, key, value) {
  const s = ensureGuild(guildId);
  s[key] = value;
  save("guild_settings");
}

// ─── Directives: persistent behavioral rules given by admins in natural language ──
export function getDirectives(guildId) {
  return ensureGuild(guildId).directives || [];
}
export function addDirective(guildId, text, channelId = null, addedBy = null) {
  const g = ensureGuild(guildId);
  if (!g.directives) g.directives = [];
  if (g.directives.length >= 50) return { success: false, reason: "max 50 directives per server" };
  const lower = text.toLowerCase().trim();
  if (g.directives.some(d => d.text.toLowerCase().trim() === lower)) return { success: false, reason: "duplicate directive" };
  g.directives.push({ text: text.substring(0, 300), channel: channelId || null, addedBy, addedAt: Date.now() });
  save("guild_settings");
  return { success: true, index: g.directives.length - 1 };
}
export function removeDirective(guildId, indexOrKeyword) {
  const g = ensureGuild(guildId);
  if (!g.directives?.length) return { success: false, reason: "no directives saved" };
  const idx = typeof indexOrKeyword === "number" ? indexOrKeyword : g.directives.findIndex(d => d.text.toLowerCase().includes(String(indexOrKeyword).toLowerCase()));
  if (idx < 0 || idx >= g.directives.length) return { success: false, reason: "directive not found" };
  const removed = g.directives.splice(idx, 1)[0];
  save("guild_settings");
  return { success: true, removed: removed.text };
}

/**
 * Get a specific feature config for a guild.
 * Returns defaults merged with any saved overrides.
 */
export function getFeatureConfig(guildId, feature) {
  const defaults = {
    economy: { enabled: true, channel_id: null, ping_role_ids: [] },
    gambling: { enabled: true, channel_id: null, ping_role_ids: [] },
    events: { enabled: true, channel_id: null, ping_role_ids: [] },
    confessions: { enabled: true, channel_id: null, ping_role_ids: [] },
    boss_battles: { enabled: true, channel_id: null, ping_role_ids: [] },
    stocks: { enabled: true, channel_id: null, ping_role_ids: [] },
    heists: { enabled: true, channel_id: null, ping_role_ids: [] },
    territories: { enabled: true, channel_id: null, ping_role_ids: [] },
    pets: { enabled: true },
    daily_challenges: { enabled: true, channel_id: null, ping_role_ids: [] },
    achievements: { enabled: true, channel_id: null },
    loans: { enabled: true },
  };
  const guild = getGuildSettings(guildId);
  const saved = guild[`feature_${feature}`] || {};
  return { ...(defaults[feature] || { enabled: true }), ...saved };
}

export function setFeatureConfig(guildId, feature, updates) {
  const s = ensureGuild(guildId);
  const key = `feature_${feature}`;
  s[key] = { ...(s[key] || {}), ...updates };
  save("guild_settings");
}

// ─── GRACEFUL SHUTDOWN ───
// Bounded so a hung Supabase request can't block exit forever. Returns when
// either the flush completes or the timeout elapses — whichever is first.
const _SHUTDOWN_FLUSH_TIMEOUT_MS = 4000;
export async function flushAll() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  // Mark every persistable bucket dirty so anything mutated since the last
  // flush gets pushed. Guild settings used to get skipped here, which meant
  // a directive added in the last 200ms could vanish on shutdown.
  _dirty.add("mood");
  _dirty.add("relationships");
  _dirty.add("guild_settings");
  try {
    await Promise.race([
      _flushSave(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("flush_timeout")), _SHUTDOWN_FLUSH_TIMEOUT_MS)),
    ]);
    log("[DB] Final flush complete");
  } catch (e) {
    log(`[DB] Final flush incomplete: ${e.message}`);
  }
}
