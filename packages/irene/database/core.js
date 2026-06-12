/**
 * @file packages/irene/database/core.js
 * @module irene/database/core
 *
 * Shared core of Irene's persistence layer — the single source of truth for
 * the in-memory cache plus the debounced flush pipeline to Supabase. The
 * public-facing helpers live in the sibling domain modules under
 * ./database/* and re-export through the ../database.js barrel; every one of
 * them imports the cache (`data`), the Supabase client (`getSupabase`/
 * `supabase`), the `save()` debouncer, the per-entity dirty tracker
 * (`_markEntity`), and the `ensureGuild` helper from THIS module.
 *
 * Why everything mutable lives here:
 *   `data` and `supabase` are REASSIGNED (initDatabase swaps `supabase`;
 *   _internal.__resetForTest swaps `data`). ESM live bindings mean the domain
 *   modules that `import { data, supabase } from "./core.js"` always observe
 *   the current object after a reassignment, so there is exactly ONE cache,
 *   ONE Supabase client, ONE dirty-set, and ONE save timer in the process.
 *   Domain modules import core; core MUST NOT import any domain module — that
 *   keeps the dependency graph acyclic.
 *
 * See ../database.js for the full architecture notes (debounce window, retry
 * policy, REQUIRE_PERSISTENCE posture, dual-write fanout, lock model).
 */

import { createClient } from "@supabase/supabase-js";
import config from "../config.js";
import { log } from "../utils/logger.js";

// Dual-write target — only invoked when config.dualWritePersistence is true.
// Imported lazily inside _flushSave to avoid a circular module load at boot
// (perEntity.js imports getSupabase from this file).
let _perEntityModule = null;
async function _getPerEntity() {
  if (!_perEntityModule) _perEntityModule = await import("./perEntity.js");
  return _perEntityModule;
}
// Saga replayer — same lazy-import dance: sagaReplayer.js calls getSupabase
// from this file and imports perEntity lazily too. Only invoked when the
// dual-write flag is on; a no-op otherwise.
let _sagaModule = null;
async function _getSaga() {
  if (!_sagaModule) _sagaModule = await import("../sagaReplayer.js");
  return _sagaModule;
}

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE — single source of truth for all reads (synchronous)
// ═══════════════════════════════════════════════════════════════════════════

// ─── In-memory cache ─────────────────────────────────────────────────────────

/**
 * Loosely-typed in-memory cache row. The cache mirrors heterogeneous Supabase
 * rows / JSON blobs, so element access stays dynamic (mirrors eris database.js).
 * @typedef {Record<string, any>} Row
 */

/**
 * @typedef {object} CacheData
 * @property {Record<string, any>} scrim_stats
 * @property {Row[]} warnings
 * @property {Record<string, any>} guild_settings
 * @property {Record<string, any>} custom_commands
 * @property {string[]} dm_optout
 * @property {number} _nextWarningId
 * @property {Record<string, any>} conversations
 * @property {Row[]} reminders
 * @property {number} _nextReminderId
 * @property {Row[]} scheduled_tasks
 * @property {number} _nextScheduledTaskId
 * @property {Record<string, any>} starboard_entries
 * @property {Row[]} birthdays
 * @property {Record<string, any>} birthday_announced
 * @property {Record<string, any>} saved_queues
 * @property {Row[]} giveaways
 * @property {Record<string, any>} highlights
 * @property {{ mood_score: number, energy: number }} mood
 * @property {Record<string, any>} relationships
 * @property {Record<string, any>} temp_vcs
 */

/** @type {CacheData} */
export let data = {
  scrim_stats: {},
  warnings: [],
  guild_settings: {},
  custom_commands: {},
  dm_optout: [],
  _nextWarningId: 1,
  conversations: {},
  reminders: [],
  _nextReminderId: 1,
  scheduled_tasks: [],
  _nextScheduledTaskId: 1,
  starboard_entries: {},
  birthdays: [],
  birthday_announced: {},
  // server_whitelist intentionally absent — the whitelist is UNIFIED and lives
  // in the canonical bot_data:main row (see getWhitelist/isWhitelisted/etc.).
  // Irene no longer keeps a local copy or persists one to its id="irene" blob.
  saved_queues: {},
  giveaways: [],
  highlights: {},
  // ─── Emotional State (synced with Eris) ───
  mood: { mood_score: 0, energy: 50 },
  relationships: {},  // userId → { affinity_score, interactions_count }
  temp_vcs: {},       // channelId → vcData — top-level to avoid polluting guild_settings
};

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT & INITIAL LOAD — restores cache from prior process
// ═══════════════════════════════════════════════════════════════════════════

// ─── Supabase client ─────────────────────────────────────────────────────────

let supabase = null;

export function getSupabase() { return supabase; }

export async function initDatabase() {
  if (!config.supabaseEnabled) {
    if (config.requirePersistence) {
      throw new Error(
        "[DB] REQUIRE_PERSISTENCE=1 but SUPABASE_URL / SUPABASE_KEY are missing or invalid. " +
        "Refusing to boot in in-memory mode. Set valid Supabase credentials or unset REQUIRE_PERSISTENCE."
      );
    }
    log("[DB] ⚠️  IRENE WITHOUT PERSISTENCE — all moderation state, settings,");
    log("[DB] ⚠️  warns, tickets, reminders, giveaways will RESET on every restart.");
    log("[DB] ⚠️  Set SUPABASE_URL/SUPABASE_KEY (see docs/self-hosting.md for");
    log("[DB] ⚠️  local-Postgres or self-hosted-Supabase setup), or set");
    log("[DB] ⚠️  REQUIRE_PERSISTENCE=1 in .env to fail-fast instead.");
    return;
  }

  try {
    supabase = createClient(config.supabaseUrl, config.supabaseKey);
  } catch (err) {
    supabase = null;
    if (config.requirePersistence) {
      throw new Error(
        `[DB] REQUIRE_PERSISTENCE=1 but Supabase client creation failed: ${err.message}. ` +
        "Refusing to boot in in-memory mode."
      );
    }
    log(`[DB] Invalid Supabase config: ${err.message}`);
    return;
  }

  // Retry up to 3 times — Render cold starts sometimes have transient network delays
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data: row, error } = await supabase
        .from("bot_data")
        .select("data")
        .eq("id", "irene")
        .single();

      if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows found

      if (row?.data) {
        const loaded = row.data;
        if (loaded.guild_settings) data.guild_settings = loaded.guild_settings;
        if (loaded.custom_commands) data.custom_commands = loaded.custom_commands;
        if (loaded.warnings) data.warnings = loaded.warnings;
        if (loaded.dm_optout) data.dm_optout = loaded.dm_optout;
        if (loaded._nextWarningId) data._nextWarningId = loaded._nextWarningId;
        if (loaded.conversations) data.conversations = loaded.conversations;
        if (loaded.reminders) data.reminders = loaded.reminders;
        if (loaded._nextReminderId) data._nextReminderId = loaded._nextReminderId;
        if (loaded.scheduled_tasks) data.scheduled_tasks = loaded.scheduled_tasks;
        if (loaded._nextScheduledTaskId) data._nextScheduledTaskId = loaded._nextScheduledTaskId;
        if (loaded.starboard_entries) data.starboard_entries = loaded.starboard_entries;
        if (loaded.birthdays) data.birthdays = loaded.birthdays;
        if (loaded.birthday_announced) data.birthday_announced = loaded.birthday_announced;
        // server_whitelist deliberately NOT loaded from the id="irene" blob — the
        // whitelist is now unified in bot_data:main. The old id="irene" copy (if
        // any) is dead; migration 008 merges its entries into main one time.
        if (loaded.saved_queues) data.saved_queues = loaded.saved_queues;
        if (loaded.scrim_stats) data.scrim_stats = loaded.scrim_stats;
        if (loaded.giveaways) data.giveaways = loaded.giveaways;
        if (loaded.highlights) data.highlights = loaded.highlights;
        if (loaded.mood) {
          data.mood = {
            mood_score: Math.max(-100, Math.min(100, Number(loaded.mood.mood_score) || 0)),
            energy: Math.max(0, Math.min(100, Number(loaded.mood.energy) || 50)),
          };
        }
        if (loaded.relationships) data.relationships = loaded.relationships;
        if (loaded.temp_vcs) data.temp_vcs = loaded.temp_vcs;
        log("[DB] Loaded from Supabase");
      } else {
        log("[DB] No existing data in Supabase — starting fresh");
      }
      return; // success
    } catch (err) {
      log(`[DB] Supabase init attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  supabase = null;
  if (config.requirePersistence) {
    throw new Error(
      "[DB] REQUIRE_PERSISTENCE=1 and all 3 Supabase init attempts failed. " +
      "Refusing to boot in in-memory mode."
    );
  }
  log("[DB] All Supabase init attempts failed — running without persistence");
}

// ═══════════════════════════════════════════════════════════════════════════
// SAVE PIPELINE — debounced writes, retry/backoff, immediate flush on shutdown
// ═══════════════════════════════════════════════════════════════════════════

// ─── Save — debounced + retry, DIRTY-SET keyed ────────────────────────────────
// Coalesces rapid back-to-back writes into one Supabase call (2 s window).
// Retries up to 3 times on failure, then reschedules after 30 s.
//
// Dirty-set: each top-level slice of `data` (guild_settings, warnings, mood, …)
// is tracked independently. `save("guild_settings")` marks only that slice
// dirty; on flush we re-serialize ONLY the dirty slices and merge them into the
// persisted blob (read-modify-write), so write cost scales with what changed
// rather than total install size. A bare `save()` (no bucket) conservatively
// marks ALL slices dirty — the same full-blob behavior as before, kept as the
// safe default for the many call sites that mutate small flat collections.
//
// The full set of top-level slices we persist. Used to expand a bare save()
// into "everything dirty" and to bound the dirty-set key space. Kept in sync
// with the `data` initializer and the initDatabase loader above.
const _PERSISTED_SLICES = [
  "scrim_stats", "warnings", "guild_settings", "custom_commands", "dm_optout",
  "_nextWarningId", "conversations", "reminders", "_nextReminderId",
  "scheduled_tasks", "_nextScheduledTaskId", "starboard_entries", "birthdays",
  "birthday_announced", "saved_queues", "giveaways",
  "highlights", "mood", "relationships", "temp_vcs",
  // NOTE: server_whitelist intentionally omitted — the whitelist is unified in
  // bot_data:main and never persisted to Irene's own blob.
];

let _saveTimer = null;
let _saveRetryCount = 0;
const MAX_SAVE_RETRIES = 10;

// Top-level slices changed since the last successful flush. Empty = nothing to
// write. A bare save() fills this with every slice (full-blob fallback).
const _dirty = new Set();

// Per-entity dirty keys for the guild-keyed slices (guild_settings,
// custom_commands, scrim_stats, starboard_entries, saved_queues). When a
// slice's set here is non-empty the per-entity fanout writes ONLY those guild
// rows instead of re-emitting every guild — so a single-guild edit costs one
// per-entity row. An EMPTY set for a dirty slice means "key unknown" (a write
// that bypassed the registration helper) → the fanout safely re-emits all rows.
const _dirtyEntities = new Map(); // slice → Set<guildId>

// Register a per-guild entity as dirty so the fanout can scope to it. Called
// from ensureGuild (covers ~all guild_settings mutators) and from the handful
// of per-guild mutators on other slices.
function _markEntity(slice, key) {
  // No persistence connected → nothing will ever flush, so don't accumulate
  // dirty keys (mirrors save()'s in-memory-mode short-circuit, avoids a leak).
  if (!supabase || key == null) return;
  let set = _dirtyEntities.get(slice);
  if (!set) { set = new Set(); _dirtyEntities.set(slice, set); }
  set.add(String(key));
}

// Re-queue a flush's snapshot back onto the live dirty state after a failed
// write so a retry re-serializes + re-fans exactly what we tried to persist.
// Unions with anything written concurrently during the failed flush.
function _requeueDirty(dirty, dirtyEntities) {
  for (const s of dirty) _dirty.add(s);
  for (const [slice, set] of dirtyEntities) {
    for (const key of set) _markEntity(slice, key);
  }
}

function hasNonEmptyJsonPayload(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return JSON.stringify(value).length >= 5;
  if (typeof value !== "object") return String(value).length >= 5;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function save(bucket) {
  if (!supabase) { log("[DB] Write discarded — Supabase not connected (data is in-memory only)"); return; }
  // Mark the changed slice dirty. A known bucket name keys the slice; anything
  // else (including a bare save()) conservatively marks every slice dirty so we
  // never silently drop a write whose origin we can't attribute.
  if (typeof bucket === "string" && _PERSISTED_SLICES.includes(bucket)) {
    _dirty.add(bucket);
  } else {
    for (const s of _PERSISTED_SLICES) _dirty.add(s);
  }
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushSave, 2000);
}

// Immediate flush — call on shutdown to prevent data loss from the 2s debounce window
export async function flushNow() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = null;
  if (!supabase) return;
  await _flushSave();
  // Drain the per-entity coalesce queue too — only matters when dual-write
  // is enabled but cheap to call unconditionally (no-op when nothing pending).
  if (config.dualWritePersistence) {
    try {
      const pe = await _getPerEntity();
      await pe.flushPerEntityNow();
    } catch (err) {
      log(`[DB] Per-entity flush failed: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-KEY MUTEX — serialise read-modify-write sequences against the same key
// ═══════════════════════════════════════════════════════════════════════════
//
// Reads are sync; the event loop is the only writer. But an `await` inside a
// read-modify-write (e.g. updateRelationship doing a getRelationship → compute
// → write while another interaction interleaves) can lose an update. This is a
// per-key promise chain mirroring Eris's withEconLock/withUserLock: each new
// call links onto the previous op for the same key, so two concurrent mutations
// of the same key run strictly one-after-another instead of racing the cache.
//
// Keyed loosely (userId, guildId, or any string) — different keys never block
// each other. The map entry is deleted once the chain drains so it doesn't grow
// unbounded across the unique-key space.
const _userLocks = new Map(); // key → Promise (tail of the per-key op chain)

export async function withUserLock(key, fn) {
  // Wait for any previous op on this key to finish (success OR failure — a
  // crashed predecessor must not deadlock its successors), then run fn().
  const prev = _userLocks.get(key) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _userLocks.set(key, current);
  try {
    return await current;
  } finally {
    // Only clear if we're still the tail — a later caller may have chained on.
    if (_userLocks.get(key) === current) _userLocks.delete(key);
  }
}

// The catch-all slices that collapse into the single per-bot irene_global_state
// row. A write touching ANY of these re-emits the whole global-state row (it's
// one Supabase row regardless), but we only emit it when one is actually dirty.
const _GLOBAL_STATE_SLICES = [
  "_nextWarningId", "_nextReminderId", "_nextScheduledTaskId", "dm_optout",
  "warnings", "reminders", "scheduled_tasks", "birthdays", "birthday_announced",
  "giveaways", "highlights", "temp_vcs", "conversations",
];

// Dual-write fanout — splits the sanitized blob into per-entity writes when
// config.dualWritePersistence is on. Iterates per-guild keyed objects so each
// guild gets its own row in the per-entity tables; global state collapses
// into a single row keyed on bot_name.
//
// `dirty` is the set of top-level slices changed this flush; `dirtyEntities`
// maps each per-guild slice to the specific guild ids that changed. We only
// fan out (a) the slices that changed and (b) within a per-guild slice, only
// the guilds that changed — so a single-guild edit writes ONE per-entity row
// rather than re-upserting every guild's row (the head-of-line stall the blob
// path had). When a slice is dirty but its entity set is empty (a write that
// bypassed _markEntity), we safely re-emit every guild for that slice.
async function _dualWriteFanout(snapshot, dirty, dirtyEntities) {
  const pe = await _getPerEntity();
  const writes = [];

  // Fan out one per-guild slice: write only the dirty guild rows, or all rows
  // if the dirty-entity set is empty/unknown (safe fallback — never drop a row).
  const fanGuilds = (slice, source, writer) => {
    if (!dirty.has(slice)) return;
    const obj = source || {};
    const keys = dirtyEntities.get(slice);
    if (keys && keys.size > 0) {
      for (const gid of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, gid)) writes.push(writer(gid, obj[gid]));
      }
    } else {
      for (const [gid, val] of Object.entries(obj)) writes.push(writer(gid, val));
    }
  };

  fanGuilds("guild_settings", snapshot.guild_settings, pe.writeGuildSettings);
  fanGuilds("custom_commands", snapshot.custom_commands, pe.writeCustomCommands);
  fanGuilds("scrim_stats", snapshot.scrim_stats, pe.writeScrimStats);
  fanGuilds("starboard_entries", snapshot.starboard_entries, pe.writeStarboardEntries);
  fanGuilds("saved_queues", snapshot.saved_queues, pe.writeSavedQueue);

  // Global state — single row each.
  if (dirty.has("mood") && snapshot.mood) writes.push(pe.writeMoodState(snapshot.mood));
  if (dirty.has("relationships") && snapshot.relationships) writes.push(pe.writeRelationships(snapshot.relationships));

  // Catch-all — counters and cross-guild flat collections in one row. Only
  // re-emit when one of its constituent slices changed.
  if (_GLOBAL_STATE_SLICES.some((s) => dirty.has(s))) {
    writes.push(pe.writeGlobalState({
      _nextWarningId: snapshot._nextWarningId,
      _nextReminderId: snapshot._nextReminderId,
      _nextScheduledTaskId: snapshot._nextScheduledTaskId,
      dm_optout: snapshot.dm_optout,
      warnings: snapshot.warnings,
      reminders: snapshot.reminders,
      scheduled_tasks: snapshot.scheduled_tasks,
      birthdays: snapshot.birthdays,
      birthday_announced: snapshot.birthday_announced,
      giveaways: snapshot.giveaways,
      highlights: snapshot.highlights,
      temp_vcs: snapshot.temp_vcs,
      conversations: snapshot.conversations,
    }));
  }

  await Promise.all(writes);
}

async function _flushSave() {
  _saveTimer = null;
  if (!supabase) return;

  // Snapshot + clear the dirty set up front. Writes that arrive DURING this
  // flush re-mark their slice and re-arm a fresh debounce — they're not lost.
  // Nothing dirty means an earlier flush already drained the changes, so we
  // skip both the blob upsert and the saga/fanout entirely (no-op flush).
  const dirty = new Set(_dirty);
  _dirty.clear();
  if (dirty.size === 0) return;
  // Snapshot + clear the per-guild dirty-entity keys alongside the slice set so
  // the fanout below scopes to exactly the guilds that changed this flush.
  const dirtyEntities = new Map();
  for (const [slice, set] of _dirtyEntities) dirtyEntities.set(slice, new Set(set));
  _dirtyEntities.clear();

  // The legacy single-row blob is the system of record for cold boot
  // (initDatabase reads it), and a jsonb row inherently carries every slice,
  // so the blob payload stays whole. The bounded-write win lives in the
  // per-entity fanout below, which only re-emits the slices in `dirty` — a
  // single-guild edit writes ONE guild_settings row instead of all of them.
  // Sanitize before save — strip non-serializable or oversized fields.
  let saveData;
  try {
    // Trim conversations to last 10 per channel to prevent payload bloat —
    // only walk them when conversations actually changed this flush.
    if (dirty.has("conversations") && data.conversations && typeof data.conversations === "object") {
      for (const [ch, msgs] of Object.entries(data.conversations)) {
        if (Array.isArray(msgs) && msgs.length > 10) {
          data.conversations[ch] = msgs.slice(-10);
        }
      }
    }
    const snapshot = structuredClone(data);
    if (!hasNonEmptyJsonPayload(snapshot)) {
      log("[DB] Save aborted - data snapshot was empty/invalid");
      // Re-mark so the changes aren't silently lost on the next flush.
      _requeueDirty(dirty, dirtyEntities);
      return;
    }
    saveData = snapshot;
  } catch (serErr) {
    log(`[DB] Save aborted — serialization failed: ${serErr.message}`);
    _requeueDirty(dirty, dirtyEntities);
    return;
  }

  // Saga bookkeeping — only when dual-write is on. Tracks each fanout so a
  // primary-succeeded-secondary-failed case becomes a replayable row instead
  // of silent drift. createSaga returns null on its own failure, in which
  // case markSagaLeg is a no-op and we just proceed without tracking.
  let sagaId = null;
  if (config.dualWritePersistence) {
    try {
      const saga = await _getSaga();
      sagaId = await saga.createSaga("fanout-snapshot", "snapshot", saveData);
    } catch (sErr) {
      log(`[DB] saga create failed (non-fatal): ${sErr.message}`);
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await supabase.from("bot_data").upsert({ id: "irene", data: saveData });
      if (!error) {
        _saveRetryCount = 0;
        // Primary leg landed — stamp the saga before we touch the secondary.
        if (sagaId) {
          try {
            const saga = await _getSaga();
            await saga.markSagaLeg(sagaId, "primary", "applied");
          } catch (sErr) {
            log(`[DB] saga primary-mark failed (non-fatal): ${sErr.message}`);
          }
        }
        // Dual-write fanout: when the flag is on, also write each entity to
        // its dedicated per-entity table. Runs AFTER the legacy blob write
        // succeeds so a per-entity bug can never break the existing path.
        // Errors are caught and recorded on the saga so the replayer can
        // retry the secondary leg later without losing the payload.
        if (config.dualWritePersistence) {
          let secondaryOk = true;
          let secondaryErrMsg = null;
          try { await _dualWriteFanout(saveData, dirty, dirtyEntities); }
          catch (dwErr) {
            secondaryOk = false;
            secondaryErrMsg = dwErr?.message ?? String(dwErr);
            log(`[DB] Dual-write fanout failed: ${secondaryErrMsg}`);
          }
          if (sagaId) {
            try {
              const saga = await _getSaga();
              await saga.markSagaLeg(
                sagaId,
                "secondary",
                secondaryOk ? "applied" : "failed",
                secondaryOk ? undefined : secondaryErrMsg,
              );
            } catch (sErr) {
              log(`[DB] saga secondary-mark failed (non-fatal): ${sErr.message}`);
            }
          }
        }
        return;
      }
      throw new Error(error.message);
    } catch (err) {
      log(`[DB] Save attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  // All three primary attempts failed — record on the saga so the row isn't
  // left in 'pending' forever (the reconciler ignores 'pending' rows since
  // primary may still be in-flight from another worker).
  if (sagaId) {
    try {
      const saga = await _getSaga();
      await saga.markSagaLeg(sagaId, "primary", "failed", "primary upsert failed after 3 attempts");
    } catch (sErr) {
      log(`[DB] saga primary-failure mark failed (non-fatal): ${sErr.message}`);
    }
  }
  // Re-mark the slices (and their dirty guild keys) we tried (and failed) to
  // write so the rescheduled flush below actually re-serializes + re-fans them
  // — we cleared the dirty state at the top of this flush. A merge with any
  // concurrent writes is automatic (Set union).
  _requeueDirty(dirty, dirtyEntities);
  if (_saveRetryCount >= MAX_SAVE_RETRIES) {
    log("[DB] Max retries reached — will try again in 5 min");
    _saveRetryCount = 0;
    _saveTimer = setTimeout(_flushSave, 5 * 60_000);
    return;
  }
  _saveRetryCount++;
  log("[DB] All save attempts failed — retrying in 30 s");
  _saveTimer = setTimeout(_flushSave, 30_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED GUILD-SETTINGS HELPER — used by ~every guild_settings domain module
// ═══════════════════════════════════════════════════════════════════════════

function ensureGuild(guildId) {
  if (!data.guild_settings[guildId]) data.guild_settings[guildId] = {};
  // Register the guild as dirty so a subsequent save("guild_settings") fans out
  // only this guild's per-entity row. ensureGuild is called by (almost) every
  // guild_settings mutator immediately before it mutates + saves.
  _markEntity("guild_settings", guildId);
  return data.guild_settings[guildId];
}

// Shared so core (the save pipeline + _internal test surface) and the domain
// modules all reference exactly the same state. Not part of the public barrel
// surface except where the barrel re-exports a named function.
export { save, _markEntity, _requeueDirty, ensureGuild, _getPerEntity, _getSaga };

// ─── Test-only internals ─────────────────────────────────────────────────────
// Exposed so tests can drive the dirty-set flush pipeline and the per-key mutex
// without a live Supabase. Not part of the public API — do not use at runtime.
export const _internal = {
  get data() { return data; },
  get dirty() { return _dirty; },
  get dirtyEntities() { return _dirtyEntities; },
  get userLocks() { return _userLocks; },
  save,
  flushSave: _flushSave,
  withUserLock,
  /** Inject a (fake) Supabase client so save()/_flushSave engage. */
  __setSupabaseForTest(client) { supabase = client; },
  /** Reset cache + flush state between tests. */
  __resetForTest() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _saveRetryCount = 0;
    _dirty.clear();
    _dirtyEntities.clear();
    _userLocks.clear();
    data = {
      scrim_stats: {}, warnings: [], guild_settings: {}, custom_commands: {},
      dm_optout: [], _nextWarningId: 1, conversations: {}, reminders: [],
      _nextReminderId: 1, scheduled_tasks: [], _nextScheduledTaskId: 1,
      starboard_entries: {}, birthdays: [], birthday_announced: {},
      saved_queues: {}, giveaways: [], highlights: {},
      mood: { mood_score: 0, energy: 50 }, relationships: {}, temp_vcs: {},
    };
  },
};
