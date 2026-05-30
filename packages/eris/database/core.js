/**
 * @file packages/eris/database/core.js
 * @module packages/eris/database/core
 *
 * Shared core for the Eris persistence layer (split out of the database.js
 * barrel — see that file's header for the full architecture overview). This
 * module owns the SINGLE instances of every piece of cross-domain state:
 *   - the Supabase client (`supabase`, assigned by initDatabase)
 *   - the in-memory `data` cache object (mood / relationships / reminders /
 *     guild_settings + the other loosely-typed collections)
 *   - the debounced `save()` / `_dirty` set / `_saveTimer` writer + `_flushSave`
 *   - the flush-failure durability signal (`isPersistenceHealthy`)
 *   - the graceful `flushAll()` shutdown drain + the `beforeExit` hook
 *
 * Every domain module under database/ imports this core for the client and the
 * shared cache. Core MUST NOT import any domain module — that keeps the import
 * graph acyclic (domains → core, never the reverse).
 */
import { createClient } from "@supabase/supabase-js";
import config from "../config.js";
import { log } from "../utils/logger.js";

/**
 * Error thrown by the balance helpers when a debit would go negative. Carries
 * the machine-readable `code` and the user's current `balance` so callers can
 * surface a precise "you only have N" message without a second DB read.
 * @typedef {Error & { code?: string, balance?: number }} BalanceError
 */

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
let _saveTimer = null;
let _dirty = new Set();

/**
 * In-memory cache shape. Rows are dynamic Supabase shapes (column sets vary by
 * deployed migration), so collections are typed as loose records rather than
 * locking in a column list that would drift from the schema.
 * @typedef {Record<string, any>} Row
 * @typedef {{
 *   conversations: Record<string, any>,
 *   facts: Record<string, Row[]>,
 *   notes: Row[],
 *   reminders: Row[],
 *   snippets: Row[],
 *   mood: { mood_score: number, energy: number },
 *   relationships: Record<string, any>,
 *   analytics: Row[],
 *   guild_settings: Record<string, any>,
 * }} CacheData
 */

// ─── IN-MEMORY DATA ───
/** @type {CacheData} */
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

/** Shared in-memory cache object. The single instance domain modules mutate. */
export { data };

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
export function save(bucket) {
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
export function _assertPersistenceHealthy() {
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
// Cast to access a custom one-shot guard flag stored on the process object.
const _proc = /** @type {NodeJS.Process & { __erisBeforeExitFlush?: boolean }} */ (process);
if (typeof process !== "undefined" && !_proc.__erisBeforeExitFlush) {
  _proc.__erisBeforeExitFlush = true;
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
