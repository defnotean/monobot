/**
 * @file packages/irene/database.js
 * @module irene/database
 *
 * Irene persistence layer — synchronous in-memory cache fronted by an
 * asynchronous, debounced flush to Supabase. Every read returns straight
 * from the local `data` object; every write mutates the cache, marks a
 * bucket dirty, and schedules a ~2s debounced flush. On SIGTERM/SIGINT the
 * process awaits the final flush so the cache is durable across deploys.
 *
 * Why it's shaped this way:
 *   - Discord interactions have a 3-second ack budget; we can't await
 *     network round-trips inside a slash-command handler.
 *   - Render restarts the process on every deploy, so cache-only would
 *     mean amnesia. Supabase is the system of record on cold boot.
 *
 * Domains covered (see TABLE OF CONTENTS comment below for line anchors):
 *   - guild_settings — per-guild config (welcome, log channels, ghost-ping,
 *     autorole, server rules, auto-mod rules/exemptions/violations,
 *     ticket system config, AFK, temp-VC, color roles, access role,
 *     channel/server personas, bad words, reaction roles, etc.).
 *   - moderation_log — warnings (warnings[], _nextWarningId).
 *   - tickets — config, panel, roles, types, resolution state.
 *   - reminders, scheduled_tasks — time-driven jobs with monotonic IDs.
 *   - custom_commands — per-guild trigger/response map.
 *   - trusted_users — privileged user list with a 5-minute background
 *     refresh cache (recently added) so revocations propagate without a
 *     bot restart while keeping read-path hot.
 *   - mood / relationships — emotional state synced with the Eris sibling
 *     bot via the perEntity dual-write path.
 *   - personality, persistent runtime (music queues, temp VC, lockdown),
 *     external feeds (RSS / Twitch / TTS / YouTube / GitHub), giveaways,
 *     highlights, voice stats, auto-responders, feature toggles, audit log,
 *     invite tracking, temp bans, invite filter, sticky messages,
 *     birthdays, server whitelist, starboard, conversations, DM opt-out.
 *
 * Per-entity storage pattern:
 *   Each logical entity (guild settings, custom commands, mood state,
 *   relationships, scrim stats, starboard entries, saved queues, global
 *   state) is written through helpers in ./database/perEntity.js to a
 *   dedicated `irene_*` table keyed by `guild_id` or `bot_name`. Rows
 *   carry an integer `version` for optimistic concurrency and a `data`
 *   JSON payload. Rapid writes within COALESCE_MS collapse into a single
 *   round-trip; conflicts retry up to MAX_RETRIES; insert-vs-update is
 *   negotiated via unique-violation fall-through. See
 *   `packages/irene/tests/database/perEntity.test.ts` for the contract.
 *   The perEntity module is loaded lazily inside `_flushSave` to avoid a
 *   circular import (perEntity imports `getSupabase` from this file).
 *
 * REQUIRE_PERSISTENCE — fail-fast guarantee:
 *   When the `REQUIRE_PERSISTENCE` env var is truthy, boot will abort
 *   hard if Supabase credentials are missing or the initial load throws.
 *   This is the production posture: a silent fallback to in-memory mode
 *   on Render would burn user state on every deploy.
 *
 * In-memory mode caveats:
 *   Without Supabase credentials (or in tests) the module runs purely
 *   from `data` with no flush. Nothing survives a restart. A loud
 *   warning is logged at boot so this state is impossible to miss in
 *   the logs. NEVER ship this to production — gate with REQUIRE_PERSISTENCE.
 *
 * Concurrency / lock model:
 *   - Reads are sync and unlocked; the JS event loop is the only writer.
 *   - `withUserLock(userId, fn)` serialises read-modify-write sequences
 *     against the same user (e.g. economy, affinity bumps, warning-id
 *     allocation) so two concurrent interactions can't race the cache.
 *   - The flush itself is debounced and reentrant-safe via a dirty-set;
 *     a flush in progress drains pending mutations before resolving.
 *   - Cross-process contention with the Eris sibling bot is handled at
 *     the perEntity layer through Postgres `version` checks — the loser
 *     of a version race re-reads and retries.
 *
 * Do not add new top-level table reads/writes here without also wiring
 * the perEntity helper, the boot-time loader, and a test in
 * `tests/database/perEntity.test.ts`.
 */

// ─── packages/irene/database.js ─────────────────────────────────────────
// In-memory cache + ~2s debounced flush to Supabase. Reads sync from
// cache; writes mark a bucket dirty; SIGTERM awaits final flush.
// `withUserLock(userId, fn)` for read-modify-write atomicity.
// See docs/start-here.md and the existing TOC below.

// ─── Database — Supabase backed, in-memory cache ─────────────────────────────
// All reads are synchronous (from cache). Writes update cache immediately then
// flush to Supabase in the background. On startup, loads from Supabase so data
// survives Render deploys and restarts.
//
// ─── TABLE OF CONTENTS ──────────────────────────────────────────────────────
//  1. In-memory cache + scrim stats ........................... ~line 34
//  2. Supabase client & initial load .......................... ~line 79
//  3. Save (debounced + retry) & flushNow ..................... ~line 157
//  4. Moderation — warnings ................................... ~line 230
//  5. Guild settings & directives ............................. ~line 273
//  6. Server rules + auto-mod (rules/exemptions/violations) ... ~line 319
//  7. Misc guild settings (welcome, log, ghost-ping, autorole)  ~line 496
//  8. Ticket system (config, roles, panel, types, resolution)   ~line 553
//  9. AFK / temp-VC / color roles / seasonal palettes ......... ~line 798
// 10. Access role / verification / trusted users / DM opt-out . ~line 886
// 11. Custom commands ........................................ ~line 963
// 12. Welcome embed, DM welcome, leave messages .............. ~line 1005
// 13. Conversations, channel/server personas, bad words, stats ~line 1063
// 14. Reaction roles, reminders, scheduled tasks, starboard .. ~line 1183
// 15. Birthdays & server whitelist ........................... ~line 1314
// 16. Emotional state — mood, energy, relationships .......... ~line 1425
// 17. Personality (Supabase-synced) .......................... ~line 1474
// 18. Persistent runtime — music queues, temp VC, lockdown ... ~line 1492
// 19. External feeds — RSS / Twitch / TTS / YouTube / GitHub . ~line 1589
// 20. Giveaways, highlights, voice stats, auto-responders .... ~line 1675
// 21. Feature toggles & audit log ............................ ~line 1756
// 22. Invite tracking / temp bans / invite filter / sticky msg ~line 1790
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import config from "./config.js";
import { createCustomCommandsStore } from "./database/customCommands.js";
import {
  GUILD_SETTINGS_DEFAULTS,
  STARBOARD_DEFAULTS,
  DM_WELCOME_DEFAULTS,
  LEAVE_DEFAULTS,
  ESCALATION_DEFAULTS,
  MOOD_DEFAULTS,
  RELATIONSHIP_DEFAULTS,
  withDefaults,
} from "./database/schemas.js";
import { log } from "./utils/logger.js";
// Dual-write target — only invoked when config.dualWritePersistence is true.
// Imported lazily inside _flushSave to avoid a circular module load at boot
// (perEntity.js imports getSupabase from this file).
let _perEntityModule = null;
async function _getPerEntity() {
  if (!_perEntityModule) _perEntityModule = await import("./database/perEntity.js");
  return _perEntityModule;
}
// Saga replayer — same lazy-import dance: sagaReplayer.js calls getSupabase
// from this file and imports perEntity lazily too. Only invoked when the
// dual-write flag is on; a no-op otherwise.
let _sagaModule = null;
async function _getSaga() {
  if (!_sagaModule) _sagaModule = await import("./sagaReplayer.js");
  return _sagaModule;
}

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE — single source of truth for all reads (synchronous)
// ═══════════════════════════════════════════════════════════════════════════

// ─── In-memory cache ─────────────────────────────────────────────────────────

let data = {
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
  server_whitelist: {},
  saved_queues: {},
  giveaways: [],
  highlights: {},
  // ─── Emotional State (synced with Eris) ───
  mood: { mood_score: 0, energy: 50 },
  relationships: {},  // userId → { affinity_score, interactions_count }
  temp_vcs: {},       // channelId → vcData — top-level to avoid polluting guild_settings
};

export function getScrimStats(guildId, game) {
  if (!data.scrim_stats) data.scrim_stats = {};
  if (!data.scrim_stats[guildId]) data.scrim_stats[guildId] = {};
  if (!data.scrim_stats[guildId][game]) data.scrim_stats[guildId][game] = {};
  return { ...data.scrim_stats[guildId][game] };
}

export function updateScrimStats(guildId, game, stats) {
  if (!data.scrim_stats) data.scrim_stats = {};
  if (!data.scrim_stats[guildId]) data.scrim_stats[guildId] = {};
  data.scrim_stats[guildId][game] = stats;
  _markEntity("scrim_stats", guildId);
  save("scrim_stats");
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT & INITIAL LOAD — restores cache from prior process
// ═══════════════════════════════════════════════════════════════════════════

// ─── Supabase client ─────────────────────────────────────────────────────────

let supabase = null;

export function getSupabase() { return supabase; }

export async function initDatabase() {
  if (!config.supabaseEnabled) {
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
        if (loaded.server_whitelist) data.server_whitelist = loaded.server_whitelist;
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
  "birthday_announced", "server_whitelist", "saved_queues", "giveaways",
  "highlights", "mood", "relationships", "temp_vcs",
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
  "server_whitelist", "giveaways", "highlights", "temp_vcs", "conversations",
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
      server_whitelist: snapshot.server_whitelist,
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
    const json = JSON.stringify(data);
    if (!json || json === "null" || json === "undefined" || json.length < 5) {
      log(`[DB] Save aborted — data serialized to empty/invalid (${json?.length ?? 0} chars)`);
      // Re-mark so the changes aren't silently lost on the next flush.
      _requeueDirty(dirty, dirtyEntities);
      return;
    }
    saveData = JSON.parse(json); // round-trip to strip non-serializable values
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
// MODERATION — warnings (add/get/delete/clear)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Warnings ────────────────────────────────────────────────────────────────

export function addWarning(guildId, userId, moderatorId, reason) {
  const warning = {
    id: data._nextWarningId++,
    guild_id: guildId,
    user_id: userId,
    moderator_id: moderatorId,
    reason,
    created_at: new Date().toISOString(),
  };
  data.warnings.push(warning);
  save("warnings");
  return warning;
}

export function getWarnings(guildId, userId) {
  return data.warnings
    .filter((w) => w.guild_id === guildId && w.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function deleteWarning(id, guildId) {
  const idx = data.warnings.findIndex((w) => w.id === id && w.guild_id === guildId);
  if (idx !== -1) {
    data.warnings.splice(idx, 1);
    save("warnings");
    return { changes: 1 };
  }
  return { changes: 0 };
}

export function clearWarnings(guildId, userId) {
  const before = data.warnings.length;
  data.warnings = data.warnings.filter((w) => !(w.guild_id === guildId && w.user_id === userId));
  save("warnings");
  return { changes: before - data.warnings.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// GUILD SETTINGS & DIRECTIVES — per-server key/value store + admin directives
// ═══════════════════════════════════════════════════════════════════════════

// ─── Guild Settings ───────────────────────────────────────────────────────────

function ensureGuild(guildId) {
  if (!data.guild_settings[guildId]) data.guild_settings[guildId] = {};
  // Register the guild as dirty so a subsequent save("guild_settings") fans out
  // only this guild's per-entity row. ensureGuild is called by (almost) every
  // guild_settings mutator immediately before it mutates + saves.
  _markEntity("guild_settings", guildId);
  return data.guild_settings[guildId];
}

export function getGuildSettings(guildId) {
  // Merge defaults so callers can rely on the full GUILD_SETTINGS_DEFAULTS
  // shape (channel ids default to null, counters/arrays/flags match the
  // legacy inline `??` fallbacks). Stored fields win; explicit-null in
  // stored is preserved (cleared state); `undefined` in stored does not
  // erase the default. See packages/irene/database/schemas.js.
  return withDefaults(GUILD_SETTINGS_DEFAULTS, data.guild_settings[guildId]);
}

export function setGuildSetting(guildId, key, value) {
  const gs = ensureGuild(guildId);
  gs[key] = value;
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
  // Dedup: don't save if near-identical directive exists
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

// ═══════════════════════════════════════════════════════════════════════════
// SERVER RULES & AUTO-MOD — numbered rules, exemptions, violation tracking
// ═══════════════════════════════════════════════════════════════════════════

// ─── Server Rules: structured rules Irene enforces ────────────────────────────
// Mirrors the `directives` pattern but with rule numbers (1, 2, 3 …) and
// severity. Admins use `/rules` to manage. Auto-mod (when enabled) checks
// every message against these rules.
//
// data.guild_settings[guildId].rules         = Rule[]
// data.guild_settings[guildId].rule_exemptions = Exemption[]
// data.guild_settings[guildId].rule_violations = Violation[]   // for escalation
// data.guild_settings[guildId].auto_mod_enabled = boolean      // OFF by default
//
// Rule:        { number, text, severity, addedBy, addedAt }
//   severity ∈ "low" | "medium" | "high" — used by escalation policy
// Exemption:   { userId, ruleNumber|null, reason, addedBy, addedAt, expiresAt|null }
//   ruleNumber=null means exempt from ALL rules
// Violation:   { userId, ruleNumber, messageId, severity, action, ts }

const MAX_RULES_PER_GUILD = 25;
const MAX_EXEMPTIONS_PER_GUILD = 200;
const MAX_VIOLATIONS_RETAINED = 500; // FIFO trim — we only need recent for escalation

export function getRules(guildId) {
  return data.guild_settings[guildId]?.rules ?? [];
}

export function addRule(guildId, text, severity, addedBy) {
  const g = ensureGuild(guildId);
  if (!g.rules) g.rules = [];
  if (g.rules.length >= MAX_RULES_PER_GUILD) {
    return { success: false, reason: `max ${MAX_RULES_PER_GUILD} rules per server` };
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) return { success: false, reason: "empty rule text" };
  const sev = ["low", "medium", "high"].includes(severity) ? severity : "medium";
  // Dedup against existing rule text (case-insensitive)
  const lower = trimmed.toLowerCase();
  if (g.rules.some(r => r.text.toLowerCase() === lower)) {
    return { success: false, reason: "duplicate rule" };
  }
  // Auto-number based on existing entries (max+1, so removed numbers don't reset)
  const nextNumber = g.rules.length === 0
    ? 1
    : Math.max(...g.rules.map(r => r.number)) + 1;
  const rule = {
    number: nextNumber,
    text: trimmed.substring(0, 500),
    severity: sev,
    addedBy: addedBy || null,
    addedAt: Date.now(),
  };
  g.rules.push(rule);
  save("guild_settings");
  return { success: true, rule };
}

export function removeRule(guildId, ruleNumber) {
  const g = ensureGuild(guildId);
  if (!g.rules?.length) return { success: false, reason: "no rules saved" };
  const idx = g.rules.findIndex(r => r.number === Number(ruleNumber));
  if (idx < 0) return { success: false, reason: `no rule numbered ${ruleNumber}` };
  const removed = g.rules.splice(idx, 1)[0];
  save("guild_settings");
  return { success: true, removed };
}

export function clearRules(guildId) {
  const g = ensureGuild(guildId);
  const count = g.rules?.length ?? 0;
  g.rules = [];
  save("guild_settings");
  return { success: true, count };
}

export function setAutoModEnabled(guildId, enabled) {
  const g = ensureGuild(guildId);
  g.auto_mod_enabled = !!enabled;
  save("guild_settings");
  return g.auto_mod_enabled;
}

export function isAutoModEnabled(guildId) {
  return !!data.guild_settings[guildId]?.auto_mod_enabled;
}

// ─── Rule exemptions ──────────────────────────────────────────────────────────

export function getExemptions(guildId) {
  return data.guild_settings[guildId]?.rule_exemptions ?? [];
}

export function addExemption(guildId, userId, ruleNumber, reason, addedBy, expiresAt = null) {
  const g = ensureGuild(guildId);
  if (!g.rule_exemptions) g.rule_exemptions = [];
  if (g.rule_exemptions.length >= MAX_EXEMPTIONS_PER_GUILD) {
    return { success: false, reason: `max ${MAX_EXEMPTIONS_PER_GUILD} exemptions per server` };
  }
  if (!userId) return { success: false, reason: "missing user" };
  const ruleNum = ruleNumber === null || ruleNumber === undefined ? null : Number(ruleNumber);
  // Dedup: same user + same rule (or both global) → reject
  const dup = g.rule_exemptions.find(e => e.userId === userId && e.ruleNumber === ruleNum);
  if (dup) return { success: false, reason: "exemption already exists" };
  const ex = {
    userId,
    ruleNumber: ruleNum,
    reason: String(reason || "").substring(0, 200) || null,
    addedBy: addedBy || null,
    addedAt: Date.now(),
    expiresAt: expiresAt || null,
  };
  g.rule_exemptions.push(ex);
  save("guild_settings");
  return { success: true, exemption: ex };
}

export function removeExemption(guildId, userId, ruleNumber) {
  const g = ensureGuild(guildId);
  if (!g.rule_exemptions?.length) return { success: false, reason: "no exemptions" };
  const ruleNum = ruleNumber === null || ruleNumber === undefined ? null : Number(ruleNumber);
  const idx = g.rule_exemptions.findIndex(e => e.userId === userId && e.ruleNumber === ruleNum);
  if (idx < 0) return { success: false, reason: "exemption not found" };
  const removed = g.rule_exemptions.splice(idx, 1)[0];
  save("guild_settings");
  return { success: true, removed };
}

/**
 * Check whether a user is exempt from a specific rule.
 * Returns true if the user has a global exemption (ruleNumber=null) or a
 * specific exemption for that rule. Auto-prunes expired exemptions.
 */
export function isUserExempt(guildId, userId, ruleNumber, now = Date.now()) {
  const list = data.guild_settings[guildId]?.rule_exemptions ?? [];
  if (list.length === 0) return false;
  // Lazy prune: drop expired entries before checking
  const live = list.filter(e => !e.expiresAt || e.expiresAt > now);
  if (live.length !== list.length) {
    // Mutate in place + persist (cheap — exemptions are small)
    data.guild_settings[guildId].rule_exemptions = live;
    _markEntity("guild_settings", guildId);
    save("guild_settings");
  }
  for (const e of live) {
    if (e.userId !== userId) continue;
    if (e.ruleNumber === null) return true; // global exemption
    if (e.ruleNumber === Number(ruleNumber)) return true;
  }
  return false;
}

// ─── Rule violations (for escalation) ─────────────────────────────────────────

export function recordViolation(guildId, userId, ruleNumber, messageId, severity, action) {
  const g = ensureGuild(guildId);
  if (!g.rule_violations) g.rule_violations = [];
  g.rule_violations.push({
    userId,
    ruleNumber: Number(ruleNumber),
    messageId,
    severity,
    action,
    ts: Date.now(),
  });
  // FIFO trim
  if (g.rule_violations.length > MAX_VIOLATIONS_RETAINED) {
    g.rule_violations = g.rule_violations.slice(-MAX_VIOLATIONS_RETAINED);
  }
  save("guild_settings");
}

export function getRecentViolations(guildId, userId, withinMs = 30 * 86_400_000, now = Date.now()) {
  const list = data.guild_settings[guildId]?.rule_violations ?? [];
  const cutoff = now - withinMs;
  return list.filter(v => v.userId === userId && v.ts >= cutoff);
}

// ═══════════════════════════════════════════════════════════════════════════
// MISC GUILD SETTINGS — GIF style, DM results, welcome channel, ghost-pings,
// log channel, autorole, ticket category root
// ═══════════════════════════════════════════════════════════════════════════

export function setGifEmbed(guildId, enabled) {
  ensureGuild(guildId).gif_embed = enabled;
  save("guild_settings");
}

export function setDmResults(guildId, enabled) {
  ensureGuild(guildId).dm_results = enabled;
  save("guild_settings");
}

export function getDmResults(guildId) {
  return data.guild_settings[guildId]?.dm_results ?? false; // default: OFF
}

export function setWelcomeChannel(guildId, channelId, message) {
  const s = ensureGuild(guildId);
  s.welcome_channel = channelId;
  if (message) s.welcome_message = message;
  save("guild_settings");
}

// ─── Ghost-Ping on Join ──────────────────────────────────────────────────
export function setGhostPingChannels(guildId, channelIds) {
  ensureGuild(guildId).ghost_ping_channels = channelIds;
  save("guild_settings");
}

export function getGhostPingChannels(guildId) {
  return data.guild_settings[guildId]?.ghost_ping_channels ?? [];
}

export function setLogChannel(guildId, channelId) {
  ensureGuild(guildId).log_channel = channelId;
  save("guild_settings");
}

export function setAutorole(guildId, roleId) {
  ensureGuild(guildId).autorole_id = roleId;
  save("guild_settings");
}

export function setTicketCategory(guildId, categoryId) {
  ensureGuild(guildId).ticket_category_id = categoryId;
  save("guild_settings");
}

function _cleanRoleIds(roleIds) {
  return Array.isArray(roleIds)
    ? roleIds.map(String).filter((id) => /^\d{17,20}$/.test(id))
    : [];
}

// ═══════════════════════════════════════════════════════════════════════════
// TICKET SYSTEM — roles, welcome/panel embeds, types, auto-category resolution
// ═══════════════════════════════════════════════════════════════════════════

// Legacy: both pings AND grants view access in one call. Kept as a shorthand.
// New code should prefer setTicketViewRoles / setTicketPingRoles separately.
export function setTicketModRoles(guildId, roleIds) {
  const clean = _cleanRoleIds(roleIds);
  const gs = ensureGuild(guildId);
  gs.ticket_mod_role_ids  = clean;
  gs.ticket_view_role_ids = clean;
  gs.ticket_ping_role_ids = clean;
  save("guild_settings");
}

// Roles granted ViewChannel + SendMessages on every new ticket. [] = nobody
// beyond the opener + bot. Category-level perms can still grant broader
// access without adding anything here. Also clears the legacy combined
// ticket_mod_role_ids field so once an admin touches the new split settings,
// the old field stops acting as a fallback (which would re-apply old
// ping+view intentions the admin explicitly narrowed).
export function setTicketViewRoles(guildId, roleIds) {
  const gs = ensureGuild(guildId);
  gs.ticket_view_role_ids = _cleanRoleIds(roleIds);
  if (!Array.isArray(gs.ticket_ping_role_ids)) gs.ticket_ping_role_ids = [];
  delete gs.ticket_mod_role_ids;
  save("guild_settings");
}

// Roles mentioned in the welcome message when a ticket opens. [] = no ping.
// Independent of view access — you can ping without granting view (e.g. alert
// a staff role that then has to react) or grant view without pinging.
export function setTicketPingRoles(guildId, roleIds) {
  const gs = ensureGuild(guildId);
  gs.ticket_ping_role_ids = _cleanRoleIds(roleIds);
  if (!Array.isArray(gs.ticket_view_role_ids)) gs.ticket_view_role_ids = [];
  delete gs.ticket_mod_role_ids;
  save("guild_settings");
}

// Welcome embed (shown INSIDE each new ticket channel). null = default.
// color accepts hex strings with or without #; stored as integer or null.
export function setTicketWelcome(guildId, { title, description, color } = {}) {
  const gs = ensureGuild(guildId);
  if (title !== undefined) gs.ticket_welcome_title = title ? String(title).slice(0, 256) : null;
  if (description !== undefined) gs.ticket_welcome_description = description ? String(description).slice(0, 4000) : null;
  if (color !== undefined) gs.ticket_welcome_color = _parseColor(color);
  save("guild_settings");
}

// Panel embed (the "Support Tickets / click the button" message posted in a
// channel). null on any field = fall back to the default for that field.
// button_label + button_emoji are bundled here because they ship with the
// embed as one unit.
export function setTicketPanel(guildId, { title, description, color, button_label, button_emoji } = {}) {
  const gs = ensureGuild(guildId);
  if (title        !== undefined) gs.ticket_panel_title        = title        ? String(title).slice(0, 256)   : null;
  if (description  !== undefined) gs.ticket_panel_description  = description  ? String(description).slice(0, 4000) : null;
  if (color        !== undefined) gs.ticket_panel_color        = _parseColor(color);
  if (button_label !== undefined) gs.ticket_panel_button_label = button_label ? String(button_label).slice(0, 80) : null;
  if (button_emoji !== undefined) gs.ticket_panel_button_emoji = button_emoji ? String(button_emoji).slice(0, 64) : null;
  save("guild_settings");
}

// Remember where we last posted a panel so the next "Post Panel" click can
// edit that message instead of spamming duplicates. null clears it.
export function setTicketPanelMessage(guildId, channelId, messageId) {
  const gs = ensureGuild(guildId);
  if (channelId && messageId) {
    gs.ticket_panel_channel_id = String(channelId);
    gs.ticket_panel_message_id = String(messageId);
  } else {
    delete gs.ticket_panel_channel_id;
    delete gs.ticket_panel_message_id;
  }
  save("guild_settings");
}

// Ticket TYPES — each type routes to its own category. Admins can define
// multiple types (e.g. Support/Reports/Appeals) and the panel renders one
// button per type. A ticket opened via a type button lands in that type's
// category. If no types are defined, the panel uses the legacy single-button
// flow with ticket_category_id as the destination.
//
// Type shape:
//   { key, label, emoji?, category_id?, style? }
// - key       — unique identifier within the guild, 1–50 chars, [a-z0-9_-]
// - label     — button text, max 80 chars
// - emoji     — unicode emoji or custom <:name:id>, optional
// - category_id — where tickets of this type go. If null/missing/deleted,
//                falls back to ticket_category_id at ticket-creation time.
// - style     — Discord ButtonStyle name: "Primary"|"Secondary"|"Success"|"Danger"
//                Defaults to Primary. Link is NOT allowed (buttons must be
//                interactive to open a ticket).
const TICKET_TYPE_KEY = /^[a-z0-9_-]{1,50}$/;
const ALLOWED_BUTTON_STYLES = new Set(["Primary", "Secondary", "Success", "Danger"]);

function _sanitizeTicketType(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key || "").trim().toLowerCase();
  if (!TICKET_TYPE_KEY.test(key)) return null;
  const label = String(raw.label || raw.title || key).trim().slice(0, 80);
  if (!label) return null;
  const out = { key, label };
  if (raw.emoji)        out.emoji = String(raw.emoji).trim().slice(0, 64);
  if (raw.category_id)  out.category_id = String(raw.category_id).trim();
  if (raw.style && ALLOWED_BUTTON_STYLES.has(String(raw.style))) out.style = String(raw.style);
  return out;
}

// Replace the entire types list. Pass [] to clear. Duplicate keys are
// deduped (last write wins). Invalid entries are silently dropped so a
// half-bad AI call can still land the good entries.
export function setTicketTypes(guildId, types) {
  const gs = ensureGuild(guildId);
  const seen = new Map();
  if (Array.isArray(types)) {
    for (const t of types) {
      const clean = _sanitizeTicketType(t);
      if (clean) seen.set(clean.key, clean);
    }
  }
  gs.ticket_types = [...seen.values()];
  save("guild_settings");
  return gs.ticket_types;
}

// Add a single type (or update an existing one with the same key).
export function addTicketType(guildId, type) {
  const clean = _sanitizeTicketType(type);
  if (!clean) return null;
  const gs = ensureGuild(guildId);
  const list = Array.isArray(gs.ticket_types) ? [...gs.ticket_types] : [];
  const idx = list.findIndex((t) => t.key === clean.key);
  if (idx >= 0) list[idx] = clean;
  else list.push(clean);
  gs.ticket_types = list;
  save("guild_settings");
  return clean;
}

// Remove by key. Returns true if something was removed.
export function removeTicketType(guildId, key) {
  const k = String(key || "").toLowerCase();
  const gs = ensureGuild(guildId);
  if (!Array.isArray(gs.ticket_types)) return false;
  const before = gs.ticket_types.length;
  gs.ticket_types = gs.ticket_types.filter((t) => t.key !== k);
  if (gs.ticket_types.length !== before) { save("guild_settings"); return true; }
  return false;
}

// Auto-resolve mode: save a CATEGORY KEYWORD instead of frozen role IDs.
// When a ticket opens, the creator resolves this keyword against the live
// guild roles via the categorizer. Effect: add a new role with mod perms
// later and it automatically joins the ticket view/ping set — no need to
// re-run setup. Pass null to clear.
//
// kind: "view" | "ping"
// category: "admin" | "moderator" | "helper" | "staff" | "trusted" | null
export function setTicketAutoCategory(guildId, kind, category) {
  if (kind !== "view" && kind !== "ping") return;
  const gs = ensureGuild(guildId);
  const field = kind === "view" ? "ticket_view_auto_category" : "ticket_ping_auto_category";
  if (category) gs[field] = String(category).toLowerCase();
  else delete gs[field];
  save("guild_settings");
}

// Explicitly pin the panel to a specific channel (without a message yet).
// Used when an admin picks a panel channel up front — Post Panel will then
// post there instead of auto-creating an #open-ticket channel under the
// ticket category. Moving to a different channel invalidates the stored
// message id (can't edit a message that's no longer in-scope).
export function setTicketPanelChannel(guildId, channelId) {
  const gs = ensureGuild(guildId);
  if (channelId) {
    const next = String(channelId);
    if (gs.ticket_panel_channel_id && gs.ticket_panel_channel_id !== next) {
      delete gs.ticket_panel_message_id;
    }
    gs.ticket_panel_channel_id = next;
  } else {
    delete gs.ticket_panel_channel_id;
    delete gs.ticket_panel_message_id;
  }
  save("guild_settings");
}

// Accepts: number, "#RRGGBB", "RRGGBB", "0xRRGGBB". Returns int or null.
function _parseColor(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(0xFFFFFF, Math.floor(value)));
  const raw = String(value).trim().replace(/^#|^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
  return parseInt(raw, 16);
}

// Resolve the effective settings for a guild.
export function getTicketConfig(guildId) {
  const gs = ensureGuild(guildId);
  return {
    category_id:   gs.ticket_category_id || null,
    types:         Array.isArray(gs.ticket_types) ? gs.ticket_types : [],
    view_role_ids: Array.isArray(gs.ticket_view_role_ids) ? gs.ticket_view_role_ids : [],
    ping_role_ids: Array.isArray(gs.ticket_ping_role_ids) ? gs.ticket_ping_role_ids : [],
    view_auto_category: gs.ticket_view_auto_category || null,
    ping_auto_category: gs.ticket_ping_auto_category || null,
    welcome_title:       gs.ticket_welcome_title || null,
    welcome_description: gs.ticket_welcome_description || null,
    welcome_color:       typeof gs.ticket_welcome_color === "number" ? gs.ticket_welcome_color : null,
    panel_title:         gs.ticket_panel_title || null,
    panel_description:   gs.ticket_panel_description || null,
    panel_color:         typeof gs.ticket_panel_color === "number" ? gs.ticket_panel_color : null,
    panel_button_label:  gs.ticket_panel_button_label || null,
    panel_button_emoji:  gs.ticket_panel_button_emoji || null,
    panel_channel_id:    gs.ticket_panel_channel_id || null,
    panel_message_id:    gs.ticket_panel_message_id || null,
  };
}

// Resolve the effective view/ping role IDs for a guild at THIS moment.
// Takes the explicit pinned IDs and unions them with a live lookup against
// the auto-category (if set). The result is what should be written into the
// ticket channel's permission overwrites / ping content. Pass the guild so
// the categorizer can see the live roles cache.
export async function resolveTicketRoles(guild) {
  const cfg = getTicketConfig(guild.id);
  const { getRolesByCategory } = await import("@defnotean/shared/roleCategorizer");
  const _expand = (explicitIds, autoCat) => {
    const out = new Set();
    for (const id of explicitIds || []) if (guild.roles.cache.has(id)) out.add(id);
    if (autoCat) {
      for (const role of getRolesByCategory(guild, autoCat)) out.add(role.id);
    }
    return [...out];
  };
  return {
    view_role_ids: _expand(cfg.view_role_ids, cfg.view_auto_category),
    ping_role_ids: _expand(cfg.ping_role_ids, cfg.ping_auto_category),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AFK / TEMP-VC / COLOR ROLES / SEASONAL PALETTES — voice & cosmetic config
// ═══════════════════════════════════════════════════════════════════════════

export function setAfkSettings(guildId, channelId, timeoutMinutes) {
  const s = ensureGuild(guildId);
  s.afk_channel_id = channelId;
  s.afk_timeout_minutes = timeoutMinutes;
  save("guild_settings");
}

export function setCreateVcChannel(guildId, channelId) {
  ensureGuild(guildId).create_vc_channel_id = channelId;
  save("guild_settings");
}

export function setVcTemplate(guildId, template) {
  ensureGuild(guildId).vc_template = template;
  save("guild_settings");
}

export function getVcTemplate(guildId) {
  return data.guild_settings[guildId]?.vc_template ?? null; // null = use smart auto mode
}

export function setVcDefaultLimit(guildId, limit) {
  ensureGuild(guildId).vc_default_limit = limit ?? 0;
  save("guild_settings");
}

export function getVcDefaultLimit(guildId) {
  return data.guild_settings[guildId]?.vc_default_limit ?? 0;
}

export function setVcNamingMode(guildId, mode) {
  ensureGuild(guildId).vc_naming_mode = mode;
  save("guild_settings");
}

export function getVcNamingMode(guildId) {
  return data.guild_settings[guildId]?.vc_naming_mode ?? "smart"; // smart | anonymous | random
}

export function setVcRichPresence(guildId, enabled) {
  ensureGuild(guildId).vc_rich_presence = enabled;
  save("guild_settings");
}

export function getVcRichPresence(guildId) {
  return data.guild_settings[guildId]?.vc_rich_presence ?? true;
}

export function setVcTextChannels(guildId, enabled) {
  ensureGuild(guildId).vc_text_channels = enabled;
  save("guild_settings");
}

export function getVcTextChannels(guildId) {
  return data.guild_settings[guildId]?.vc_text_channels ?? false;
}

export function setColorRoles(guildId, roleIds) {
  ensureGuild(guildId).color_role_ids = roleIds;
  save("guild_settings");
}

export function getColorRoles(guildId) {
  return data.guild_settings[guildId]?.color_role_ids ?? [];
}

export function setSeasonalColors(guildId, enabled) {
  ensureGuild(guildId).seasonal_colors = enabled;
  save("guild_settings");
}

export function getSeasonalColors(guildId) {
  return data.guild_settings[guildId]?.seasonal_colors ?? false;
}

export function setLastSeasonalPalette(guildId, paletteName) {
  ensureGuild(guildId).last_seasonal_palette = paletteName;
  save("guild_settings");
}

export function getLastSeasonalPalette(guildId) {
  return data.guild_settings[guildId]?.last_seasonal_palette ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCESS CONTROL — Irene access role, verification gating, trusted users,
// per-user DM opt-out
// ═══════════════════════════════════════════════════════════════════════════

// ─── Irene Access Role ───────────────────────────────────────────────────────

export function setAccessRole(guildId, roleId) {
  ensureGuild(guildId).irene_access_role_id = roleId;
  save("guild_settings");
}

// ─── Verification Role ──────────────────────────────────────────────────────
// The "verified" role gates access to most channels. Unverified users can only
// see channels explicitly marked as public (rules, verification, etc.)

export function setVerificationRole(guildId, roleId) {
  ensureGuild(guildId).verification_role_id = roleId;
  save("guild_settings");
}

export function getVerificationRole(guildId) {
  return data.guild_settings[guildId]?.verification_role_id ?? null;
}

export function getPublicChannels(guildId) {
  return data.guild_settings[guildId]?.public_channels ?? [];
}

export function setPublicChannels(guildId, channelIds) {
  ensureGuild(guildId).public_channels = channelIds;
  save("guild_settings");
}

// ─── Trusted Users ───────────────────────────────────────────────────────────
// Users added here get full admin-level access to Irene's tools, same as server admins.
//
// The bot loads `data` once at boot, so without a refresh path the cache goes
// stale the moment a trusted user is revoked via direct DB edit, a sister
// shard, or any process other than this one. The risk is asymmetric:
// granting trust is fine to lag (worst case: a legit user waits a moment),
// but *revoking* trust must propagate or a recently-removed user retains
// admin-level tool access until the next restart.
//
// We can't make getTrustedUsers async without rewriting every call site, so
// we use a sync read with a background TTL-driven re-fetch: a stale cache
// triggers a fire-and-forget refresh that updates `data.guild_settings`.
// Subsequent reads see the fresh value.

const TRUSTED_TTL_MS = 5 * 60 * 1000; // 5 min — short enough to bound stale-trust window
const _trustedFetchedAt = new Map(); // guildId → epoch ms of last refresh
const _trustedRefreshInFlight = new Map(); // guildId → Promise (dedup concurrent refreshes)

async function _refreshTrustedUsers(guildId) {
  if (!supabase) return;
  if (_trustedRefreshInFlight.has(guildId)) return _trustedRefreshInFlight.get(guildId);
  const p = (async () => {
    try {
      const { data: row, error } = await supabase
        .from("bot_data")
        .select("data")
        .eq("id", "irene")
        .single();
      if (error || !row?.data?.guild_settings) return;
      const fresh = row.data.guild_settings?.[guildId]?.trusted_users ?? [];
      const current = ensureGuild(guildId);
      // Replace only the trusted_users slice — leave everything else alone so
      // we don't clobber in-flight local writes to other fields.
      current.trusted_users = fresh;
      _trustedFetchedAt.set(guildId, Date.now());
    } catch (err) {
      log(`[DB] Trusted-user refresh failed for ${guildId}: ${err.message}`);
    } finally {
      _trustedRefreshInFlight.delete(guildId);
    }
  })();
  _trustedRefreshInFlight.set(guildId, p);
  return p;
}

export function getTrustedUsers(guildId) {
  const lastFetch = _trustedFetchedAt.get(guildId) || 0;
  if (Date.now() - lastFetch > TRUSTED_TTL_MS) {
    // Mark optimistically so back-to-back stale reads only kick off one refresh.
    _trustedFetchedAt.set(guildId, Date.now());
    // Fire-and-forget — current call returns whatever's in the cache; the next
    // call after the network round-trip will see the refreshed value.
    _refreshTrustedUsers(guildId).catch(() => {});
  }
  return data.guild_settings[guildId]?.trusted_users ?? [];
}

export function addTrustedUser(guildId, userId) {
  const s = ensureGuild(guildId);
  const list = s.trusted_users ?? [];
  if (!list.includes(userId)) {
    s.trusted_users = [...list, userId];
    // Local write is authoritative — defer the next TTL refresh so we don't
    // immediately race ourselves before the save("guild_settings") flush completes.
    _trustedFetchedAt.set(guildId, Date.now());
    save("guild_settings");
  }
}

export function removeTrustedUser(guildId, userId) {
  const s = data.guild_settings[guildId];
  if (!s?.trusted_users) return;
  s.trusted_users = s.trusted_users.filter((id) => id !== userId);
  _trustedFetchedAt.set(guildId, Date.now());
  _markEntity("guild_settings", guildId);
  save("guild_settings");
}

// ─── DM Opt-Out ──────────────────────────────────────────────────────────────
// Per-user preference — if opted out, Irene won't DM them anything

export function isDmOptout(userId) {
  return data.dm_optout?.includes(userId) ?? false;
}

export function setDmOptout(userId, optout) {
  if (!data.dm_optout) data.dm_optout = [];
  if (optout) {
    if (!data.dm_optout.includes(userId)) {
      data.dm_optout.push(userId);
      save("dm_optout");
    }
  } else {
    data.dm_optout = data.dm_optout.filter((id) => id !== userId);
    save("dm_optout");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM COMMANDS — user-defined !triggers per guild
// ═══════════════════════════════════════════════════════════════════════════

// ─── Custom Commands ─────────────────────────────────────────────────────────

const _customCommandsStore = createCustomCommandsStore({
  getData: () => data,
  markEntity: _markEntity,
  save,
});

export const getCustomCommands = _customCommandsStore.getCustomCommands;

export const getCustomCommand = _customCommandsStore.getCustomCommand;

export const setCustomCommand = _customCommandsStore.setCustomCommand;

export const deleteCustomCommand = _customCommandsStore.deleteCustomCommand;
export const listCustomCommands = _customCommandsStore.listCustomCommands;

// ═══════════════════════════════════════════════════════════════════════════
// WELCOME / DM-WELCOME / LEAVE — embed customization & message templates
// ═══════════════════════════════════════════════════════════════════════════

// ─── Welcome Embed Customization ─────────────────────────────────────────────

export function getWelcomeEmbed(guildId) {
  return data.guild_settings[guildId]?.welcome_embed ?? null;
}

/**
 * Merge partial embedConfig into the stored config.
 * Pass null to fully reset all customizations.
 */
export function setWelcomeEmbed(guildId, embedConfig) {
  const s = ensureGuild(guildId);
  if (embedConfig === null) {
    delete s.welcome_embed;
  } else {
    s.welcome_embed = { ...(s.welcome_embed ?? {}), ...embedConfig };
  }
  save("guild_settings");
}

// ─── DM Welcome ───────────────────────────────────────────────────────────────

export function setDmWelcome(guildId, enabled, message) {
  const s = ensureGuild(guildId);
  s.dm_welcome_enabled = enabled;
  if (message !== undefined) s.dm_welcome_message = message;
  save("guild_settings");
}

export function getDmWelcome(guildId) {
  // Build the slice projection from stored snake_case keys, then merge over
  // DM_WELCOME_DEFAULTS. Only project keys that are actually set so that
  // unset fields fall through to defaults via withDefaults.
  const s = data.guild_settings[guildId];
  const stored = {};
  if (s?.dm_welcome_enabled !== undefined) stored.enabled = s.dm_welcome_enabled;
  if (s?.dm_welcome_message !== undefined) stored.message = s.dm_welcome_message;
  return withDefaults(DM_WELCOME_DEFAULTS, stored);
}

// ─── Leave Messages ───────────────────────────────────────────────────────────

export function setLeaveChannel(guildId, channelId, message) {
  const s = ensureGuild(guildId);
  s.leave_channel = channelId;
  if (message !== undefined) s.leave_message = message;
  save("guild_settings");
}

export function getLeaveSettings(guildId) {
  // Project stored snake_case fields into the slice shape, then merge.
  // Only project keys that are set so unset ones inherit the default.
  // Explicit-null channel id (admin cleared the leave channel) is preserved.
  const s = data.guild_settings[guildId];
  const stored = {};
  if (s?.leave_channel !== undefined) stored.channelId = s.leave_channel;
  if (s?.leave_message !== undefined) stored.message = s.leave_message;
  return withDefaults(LEAVE_DEFAULTS, stored);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATIONS, PERSONALITIES, BAD WORDS, ESCALATION & STATS CHANNELS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Conversation Memory ──────────────────────────────────────────────────────

export function saveConversation(channelKey, history) {
  if (!data.conversations) data.conversations = {};
  // Limit to last 20 messages to avoid bloat
  data.conversations[channelKey] = history.slice(-20);

  // Prevent unbounded growth of the JSON data bundle
  const keys = Object.keys(data.conversations);
  if (keys.length > 5000) {
    // Delete the oldest 100 conversations to free up space
    for (let i = 0; i < 100; i++) {
      delete data.conversations[keys[i]];
    }
  }

  save("conversations");
}

export function loadConversations() {
  const result = new Map();
  if (!data.conversations) return result;
  for (const [key, hist] of Object.entries(data.conversations)) {
    if (Array.isArray(hist) && hist.length > 0) result.set(key, hist);
  }
  return result;
}

export function getConversationsData() {
  return data.conversations || {};
}

export function deleteConversation(key) {
  if (!data.conversations) return false;
  if (data.conversations[key]) {
    delete data.conversations[key];
    save("conversations");
    return true;
  }
  // Partial match
  let deleted = false;
  for (const k of Object.keys(data.conversations)) {
    if (k.includes(key)) { delete data.conversations[k]; deleted = true; }
  }
  if (deleted) save("conversations");
  return deleted;
}

// ─── Per-Channel Personality ──────────────────────────────────────────────────

export function setChannelPersonality(guildId, channelId, prompt) {
  const s = ensureGuild(guildId);
  if (!s.channel_personalities) s.channel_personalities = {};
  if (prompt) {
    s.channel_personalities[channelId] = prompt;
  } else {
    delete s.channel_personalities[channelId];
  }
  save("guild_settings");
}

export function getChannelPersonality(guildId, channelId) {
  return data.guild_settings[guildId]?.channel_personalities?.[channelId] ?? null;
}

// ─── Server Persona ───────────────────────────────────────────────────────────
// Allows each guild to override the bot's name + personality independently.
// { name: string, personality: string } — either field may be absent (falls back to default).

export function setServerPersona(guildId, persona) {
  const s = ensureGuild(guildId);
  if (persona) {
    s.server_persona = persona; // { name, personality }
  } else {
    delete s.server_persona;
  }
  save("guild_settings");
}

export function getServerPersona(guildId) {
  return data.guild_settings[guildId]?.server_persona ?? null;
}

// ─── Bad Word Filter ──────────────────────────────────────────────────────────

export function setBadWords(guildId, words) {
  ensureGuild(guildId).bad_words = words;
  save("guild_settings");
}

export function getBadWords(guildId) {
  return data.guild_settings[guildId]?.bad_words ?? [];
}

// ─── Auto-Escalation ──────────────────────────────────────────────────────────

export function setEscalation(guildId, config) {
  ensureGuild(guildId).escalation = config;
  save("guild_settings");
}

export function getEscalation(guildId) {
  // Partial-policy admins (e.g. only mute_at set) must still observe
  // null at unset tiers — merge over ESCALATION_DEFAULTS rather than
  // returning the raw stored row.
  return withDefaults(ESCALATION_DEFAULTS, data.guild_settings[guildId]?.escalation);
}

// ─── Server Stats Channels ────────────────────────────────────────────────────

export function setStatsChannels(guildId, config) {
  ensureGuild(guildId).stats_channels = config;
  save("guild_settings");
}

export function getStatsChannels(guildId) {
  return data.guild_settings[guildId]?.stats_channels ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// REACTION ROLES, REMINDERS, SCHEDULED TASKS & STARBOARD
// ═══════════════════════════════════════════════════════════════════════════

// ─── Reaction Roles ───────────────────────────────────────────────────────────

export function addReactionRole(guildId, messageId, emoji, roleId, exclusive = true) {
  const s = ensureGuild(guildId);
  if (!s.reaction_roles) s.reaction_roles = {};
  if (!s.reaction_roles[messageId]) s.reaction_roles[messageId] = [];
  // Remove existing entry for this emoji on this message
  s.reaction_roles[messageId] = s.reaction_roles[messageId].filter((r) => r.emoji !== emoji);
  s.reaction_roles[messageId].push({ emoji, roleId, exclusive });
  save("guild_settings");
}

export function isReactionRoleExclusive(guildId, messageId) {
  const roles = data.guild_settings[guildId]?.reaction_roles?.[messageId];
  // Default to true — existing roles without the flag are treated as exclusive
  return roles?.[0]?.exclusive ?? true;
}

export function removeReactionRole(guildId, messageId, emoji) {
  const s = data.guild_settings[guildId];
  if (!s?.reaction_roles?.[messageId]) return;
  s.reaction_roles[messageId] = s.reaction_roles[messageId].filter((r) => r.emoji !== emoji);
  if (s.reaction_roles[messageId].length === 0) delete s.reaction_roles[messageId];
  _markEntity("guild_settings", guildId);
  save("guild_settings");
}

export function getReactionRoles(guildId, messageId) {
  return data.guild_settings[guildId]?.reaction_roles?.[messageId] ?? [];
}

export function getAllReactionRoles(guildId) {
  return data.guild_settings[guildId]?.reaction_roles ?? {};
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export function addReminder(userId, guildId, channelId, message, fireAt) {
  if (!data.reminders) data.reminders = [];
  const reminder = {
    id: data._nextReminderId++,
    userId,
    guildId,
    channelId,
    message,
    fireAt: typeof fireAt === "number" ? fireAt : fireAt.getTime(),
  };
  data.reminders.push(reminder);
  save("reminders");
  return reminder;
}

export function getReminders() {
  return data.reminders ?? [];
}

export function removeReminder(id) {
  if (!data.reminders) return;
  data.reminders = data.reminders.filter((r) => r.id !== id);
  save("reminders");
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────
// Deferred tool calls queued via the schedule_task AI tool.

export function addScheduledTask(guildId, channelId, authorId, toolName, toolInput, fireAt, note) {
  if (!data.scheduled_tasks) data.scheduled_tasks = [];
  const task = {
    id: data._nextScheduledTaskId++,
    guildId,
    channelId,
    authorId,
    toolName,
    toolInput,
    fireAt: typeof fireAt === "number" ? fireAt : fireAt.getTime(),
    note: note ?? null,
    createdAt: Date.now(),
  };
  data.scheduled_tasks.push(task);
  save("scheduled_tasks");
  return task;
}

export function getScheduledTasks(guildId) {
  const all = data.scheduled_tasks ?? [];
  return guildId ? all.filter((t) => t.guildId === guildId) : all;
}

export function getScheduledTask(id) {
  return (data.scheduled_tasks ?? []).find((t) => t.id === id) ?? null;
}

export function removeScheduledTask(id) {
  if (!data.scheduled_tasks) return { changes: 0 };
  const before = data.scheduled_tasks.length;
  data.scheduled_tasks = data.scheduled_tasks.filter((t) => t.id !== id);
  save("scheduled_tasks");
  return { changes: before - data.scheduled_tasks.length };
}

// ─── Starboard ────────────────────────────────────────────────────────────────

export function setStarboard(guildId, channelId, threshold) {
  const s = ensureGuild(guildId);
  s.starboard_channel = channelId;
  s.starboard_threshold = threshold ?? 3;
  save("guild_settings");
}

export function getStarboard(guildId) {
  // Project stored snake_case fields into the slice shape, then merge.
  // Only project keys that are set so unset ones inherit STARBOARD_DEFAULTS
  // (channelId: null, threshold: 3). Explicit-null channel id is preserved
  // (an admin clearing the starboard channel keeps the threshold).
  const s = data.guild_settings[guildId];
  const stored = {};
  if (s?.starboard_channel !== undefined) stored.channelId = s.starboard_channel;
  if (s?.starboard_threshold !== undefined) stored.threshold = s.starboard_threshold;
  return withDefaults(STARBOARD_DEFAULTS, stored);
}

export function addStarboardEntry(guildId, messageId, starboardMessageId) {
  if (!data.starboard_entries) data.starboard_entries = {};
  if (!data.starboard_entries[guildId]) data.starboard_entries[guildId] = {};
  data.starboard_entries[guildId][messageId] = starboardMessageId;
  _markEntity("starboard_entries", guildId);
  save("starboard_entries");
}

export function getStarboardEntry(guildId, messageId) {
  return data.starboard_entries?.[guildId]?.[messageId] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BIRTHDAYS & SERVER WHITELIST — birthday roster + bot-owner allowlisting
// ═══════════════════════════════════════════════════════════════════════════

// ─── Birthdays ─────────────────────────────────────────────────────────────────

export function setBirthday(userId, guildId, month, day, year) {
  if (!data.birthdays) data.birthdays = [];
  data.birthdays = data.birthdays.filter((b) => !(b.userId === userId && b.guildId === guildId));
  const entry = { userId, guildId, month, day };
  if (year) entry.year = year;
  data.birthdays.push(entry);
  save("birthdays");
}

export function removeBirthday(userId, guildId) {
  if (!data.birthdays) return false;
  const before = data.birthdays.length;
  data.birthdays = data.birthdays.filter((b) => !(b.userId === userId && b.guildId === guildId));
  if (data.birthdays.length !== before) { save("birthdays"); return true; }
  return false;
}

export function getBirthday(userId, guildId) {
  return (data.birthdays ?? []).find((b) => b.userId === userId && b.guildId === guildId) ?? null;
}

export function getGuildBirthdays(guildId) {
  return (data.birthdays ?? []).filter((b) => b.guildId === guildId);
}

export function getTodaysBirthdays(guildId) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return (data.birthdays ?? []).filter((b) => b.guildId === guildId && b.month === month && b.day === day);
}

export function setBirthdayChannel(guildId, channelId) {
  ensureGuild(guildId).birthday_channel_id = channelId;
  save("guild_settings");
}

export function setBirthdayRole(guildId, roleId) {
  ensureGuild(guildId).birthday_role_id = roleId;
  save("guild_settings");
}

export function setBirthdayMessage(guildId, message) {
  const s = ensureGuild(guildId);
  if (message) s.birthday_message = message;
  else delete s.birthday_message;
  save("guild_settings");
}

export function getBirthdayConfig(guildId) {
  const s = data.guild_settings[guildId];
  return {
    channel_id: s?.birthday_channel_id ?? null,
    role_id: s?.birthday_role_id ?? null,
    message: s?.birthday_message ?? "🎂 Happy Birthday {user}! Wishing you an amazing day — you deserve it! 🎉",
  };
}

export function markBirthdayAnnounced(userId, guildId) {
  const currentYear = new Date().getFullYear();
  const key = `${guildId}-${userId}-${currentYear}`;
  if (!data.birthday_announced) data.birthday_announced = {};
  data.birthday_announced[key] = true;

  // Prune entries from previous years to prevent unbounded growth
  let pruned = 0;
  for (const k of Object.keys(data.birthday_announced)) {
    const yearMatch = k.match(/-(\d{4})$/);
    if (yearMatch && parseInt(yearMatch[1]) < currentYear) {
      delete data.birthday_announced[k];
      pruned++;
    }
  }
  if (pruned > 0) log(`[DB] Pruned ${pruned} old birthday-announced entries`);

  save("birthday_announced");
}

export function wasBirthdayAnnounced(userId, guildId) {
  const key = `${guildId}-${userId}-${new Date().getFullYear()}`;
  return data.birthday_announced?.[key] === true;
}

// ─── Server Whitelist ──────────────────────────────────────────────────────

export function getWhitelist() {
  return data.server_whitelist ?? {};
}

export function isWhitelisted(guildId) {
  return !!data.server_whitelist?.[guildId];
}

export function addToWhitelist(guildId, info) {
  if (!data.server_whitelist) data.server_whitelist = {};
  data.server_whitelist[guildId] = {
    name:       info.name       ?? "Unknown",
    icon_url:   info.icon_url   ?? null,
    members:    info.members    ?? null,
    invited_by: info.invited_by ?? null,
    added_at:   new Date().toISOString(),
  };
  save("server_whitelist");
}

// ═══════════════════════════════════════════════════════════════════════════
// EMOTIONAL STATE — global mood/energy + per-user relationship affinity
// ═══════════════════════════════════════════════════════════════════════════

// ─── Mood & Energy (shared emotional state) ──────────────────────────────────

export function getMood() {
  // Merge defaults so a partial/missing in-memory row still yields the
  // full MOOD_DEFAULTS shape (mood_score: 0, energy: 50).
  return withDefaults(MOOD_DEFAULTS, data.mood);
}

export function updateMood(score, energy) {
  data.mood.mood_score = Math.max(-100, Math.min(100, score));
  data.mood.energy = Math.max(0, Math.min(100, energy));
  save("mood");
}

export function shiftMood(delta, energyDelta = 0) {
  updateMood(data.mood.mood_score + delta, data.mood.energy + energyDelta);
}

export function moodLabel(score) {
  if (score >= 60) return "ecstatic";
  if (score >= 30) return "happy";
  if (score >= 10) return "chill";
  if (score >= -10) return "neutral";
  if (score >= -30) return "annoyed";
  if (score >= -60) return "pissed";
  return "furious";
}

// ─── Relationships (per-user affinity tracking) ──────────────────────────────

export function getRelationship(userId) {
  // Merge defaults so a missing/partial row still yields the full
  // RELATIONSHIP_DEFAULTS shape (affinity_score: 0, interactions_count: 0).
  return withDefaults(RELATIONSHIP_DEFAULTS, data.relationships[userId]);
}

// Synchronous read-modify-write. Safe to call directly when no `await` sits
// between a caller's read of the relationship and this mutation — JS is
// single-threaded so a purely-sync RMW can't interleave. Use
// updateRelationshipLocked when the caller's sequence spans an await.
export function updateRelationship(userId, affinityDelta) {
  const current = getRelationship(userId);
  data.relationships[userId] = {
    affinity_score: Math.max(-100, Math.min(100, current.affinity_score + affinityDelta)),
    interactions_count: current.interactions_count + 1,
  };
  save("relationships");
}

// Lock-serialised affinity bump. Routes the read-modify-write through the
// per-user mutex so two concurrent interactions adjusting the SAME user's
// affinity can't both read the old score and clobber each other's increment —
// the documented atomicity guarantee for "affinity bumps". Returns the new
// relationship row. Prefer this over updateRelationship in async tool/event
// paths that may run concurrently for one user.
export function updateRelationshipLocked(userId, affinityDelta) {
  return withUserLock(`rel:${userId}`, () => {
    updateRelationship(userId, affinityDelta);
    return getRelationship(userId);
  });
}

export function getAllRelationships() {
  return Object.entries(data.relationships).map(([uid, r]) => ({ user_id: uid, ...r }));
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSONALITY (Supabase-synced) — editable from the dashboard
// ═══════════════════════════════════════════════════════════════════════════

// ─── Personality (Supabase-synced for dashboard editor) ─────────────────────

export async function getPersonality() {
  if (!supabase) return null;
  const { data: row } = await supabase.from("irene_personality").select("instructions").eq("id", "irene").single();
  return row?.instructions || null;
}

export async function updatePersonality(instructions) {
  if (!supabase) return false;
  const { error } = await supabase.from("irene_personality").upsert({ id: "irene", instructions });
  return !error;
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT RUNTIME STATE — music queues, temp VCs, lockdown, auto-slowmode
// ═══════════════════════════════════════════════════════════════════════════

// ─── Saved Music Queues (persist across restarts) ────────────────────────────

export function saveQueue(guildId, queueData) {
  if (!data.saved_queues) data.saved_queues = {};
  data.saved_queues[guildId] = { ...queueData, savedAt: Date.now() };
  _markEntity("saved_queues", guildId);
  save("saved_queues");
}

export function getSavedQueues() {
  return data.saved_queues ?? {};
}

export function clearSavedQueue(guildId) {
  if (data.saved_queues?.[guildId]) {
    delete data.saved_queues[guildId];
    _markEntity("saved_queues", guildId);
    save("saved_queues");
  }
}

export function clearAllSavedQueues() {
  data.saved_queues = {};
  save("saved_queues");
}

// ─── Temp VC State (persist across restarts) ─────────────────────────────────
// Stored at top-level data.temp_vcs rather than inside guild_settings["_global"]
// to keep the guild_settings namespace clean and avoid confusion with real guilds.

export function saveTempVc(channelId, vcData) {
  if (!vcData) vcData = {};
  if (!data.temp_vcs) data.temp_vcs = {};
  data.temp_vcs[channelId] = vcData;
  save("temp_vcs");
}

export function deleteTempVc(channelId) {
  if (data.temp_vcs?.[channelId]) {
    delete data.temp_vcs[channelId];
    save("temp_vcs");
  }
}

export function getAllTempVcs() {
  return data.temp_vcs ?? {};
}

export function clearAllTempVcs() {
  data.temp_vcs = {};
  save("temp_vcs");
}

// ─── Lockdown State ──────────────────────────────────────────────────────────

export function saveLockdown(guildId, expiresAt) {
  ensureGuild(guildId).lockdown_expires = expiresAt;
  save("guild_settings");
}

export function clearLockdown(guildId) {
  const s = data.guild_settings[guildId];
  if (s) { delete s.lockdown_expires; _markEntity("guild_settings", guildId); save("guild_settings"); }
}

export function getLockdown(guildId) {
  return data.guild_settings[guildId]?.lockdown_expires ?? null;
}

// ─── Auto-Slowmode State ─────────────────────────────────────────────────────

export function saveSlowmode(channelId, guildId, expiresAt) {
  ensureGuild(guildId).auto_slowmode = ensureGuild(guildId).auto_slowmode ?? {};
  ensureGuild(guildId).auto_slowmode[channelId] = expiresAt;
  save("guild_settings");
}

export function clearSlowmode(channelId, guildId) {
  const s = data.guild_settings[guildId];
  if (s?.auto_slowmode?.[channelId]) { delete s.auto_slowmode[channelId]; _markEntity("guild_settings", guildId); save("guild_settings"); }
}

export function getAutoSlowmodes(guildId) {
  return data.guild_settings[guildId]?.auto_slowmode ?? {};
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTERNAL FEEDS — RSS patch news, Twitch live, TTS, YouTube, GitHub
// ═══════════════════════════════════════════════════════════════════════════

// ─── Patch Feeds (RSS Game News) ─────────────────────────────────────────────

export function getPatchFeeds(guildId) {
  return data.guild_settings[guildId]?.patch_feeds ?? { channel_id: null, feeds: [] };
}

export function setPatchFeeds(guildId, config) {
  ensureGuild(guildId).patch_feeds = config;
  save("guild_settings");
}

export function getPatchLastSeen(guildId) {
  return data.guild_settings[guildId]?.patch_last_seen ?? {};
}

export function setPatchLastSeen(guildId, key, value) {
  const s = ensureGuild(guildId);
  if (!s.patch_last_seen) s.patch_last_seen = {};
  s.patch_last_seen[key] = value;
  save("guild_settings");
}

// ─── Twitch Live Notifications ───────────────────────────────────────────────

export function getTwitchConfig(guildId) {
  return data.guild_settings[guildId]?.twitch ?? { channel_id: null, streamers: [], ping_role_id: null, ping_role_ids: [], auto_detect: false };
}

export function setTwitchConfig(guildId, config) {
  ensureGuild(guildId).twitch = config;
  save("guild_settings");
}

// ─── TTS Channels ────────────────────────────────────────────────────────────

export function getTtsChannels(guildId) {
  return data.guild_settings[guildId]?.tts_channels ?? [];
}

export function setTtsChannels(guildId, channels) {
  ensureGuild(guildId).tts_channels = channels;
  save("guild_settings");
}

export function getTtsVoice(guildId) {
  return data.guild_settings[guildId]?.tts_voice ?? "Kore";
}

export function setTtsVoice(guildId, voice) {
  ensureGuild(guildId).tts_voice = voice;
  save("guild_settings");
}

export function removeFromWhitelist(guildId) {
  if (!data.server_whitelist?.[guildId]) return false;
  delete data.server_whitelist[guildId];
  save("server_whitelist");
  return true;
}

// ─── YouTube Feeds ──────────────────────────────────────────────────────────

export function getYoutubeConfig(guildId) {
  return data.guild_settings[guildId]?.youtube ?? [];
}

export function setYoutubeConfig(guildId, config) {
  ensureGuild(guildId).youtube = config;
  save("guild_settings");
}

// ─── GitHub Feeds ───────────────────────────────────────────────────────────

export function getGithubConfig(guildId) {
  return data.guild_settings[guildId]?.github ?? [];
}

export function setGithubConfig(guildId, config) {
  ensureGuild(guildId).github = config;
  save("guild_settings");
}

// ═══════════════════════════════════════════════════════════════════════════
// GIVEAWAYS, HIGHLIGHTS, VOICE STATS & AUTO-RESPONDERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Audit Log ──────────────────────────────────────────────────────────────

// ─── Giveaway Persistence ───────────────────────────────────────────────────

export function getGiveawayDb() {
  return data.giveaways ?? [];
}

export function saveGiveawayDb(giveawayArray) {
  data.giveaways = giveawayArray;
  save("giveaways");
}

export function getGiveawayPingRoles(guildId) {
  return data.guild_settings[guildId]?.giveaway_ping_role_ids ?? [];
}

export function setGiveawayPingRoles(guildId, roleIds) {
  ensureGuild(guildId).giveaway_ping_role_ids = roleIds;
  save("guild_settings");
}

// ─── Highlight Persistence ──────────────────────────────────────────────────

export function getHighlightDb() {
  return data.highlights ?? {};
}

export function saveHighlightDb(highlightObj) {
  data.highlights = highlightObj;
  save("highlights");
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

// ─── Voice Stats ──────────────────────────────────────────────────────────

export function getVoiceStats(guildId) {
  return data.guild_settings[guildId]?.voice_stats ?? {};
}

export function addVoiceTime(guildId, userId, minutes) {
  const s = ensureGuild(guildId);
  if (!s.voice_stats) s.voice_stats = {};
  if (!s.voice_stats[userId]) s.voice_stats[userId] = { total_minutes: 0, sessions: 0 };
  s.voice_stats[userId].total_minutes += minutes;
  s.voice_stats[userId].sessions += 1;
  save("guild_settings");
}

// ─── Auto-Responders ──────────────────────────────────────────────────────

export function getAutoResponders(guildId) {
  return data.guild_settings[guildId]?.auto_responders ?? [];
}

export function addAutoResponder(guildId, trigger, response, createdBy) {
  if (!trigger || typeof trigger !== "string" || !trigger.trim()) return false;
  if (!response || typeof response !== "string" || !response.trim()) return false;
  if (trigger.length > 100) return false; // Max trigger length
  if (response.length > 500) return false; // Max response length
  const s = ensureGuild(guildId);
  if (!s.auto_responders) s.auto_responders = [];
  s.auto_responders.push({ trigger: trigger.toLowerCase(), response, created_by: createdBy, uses: 0 });
  save("guild_settings");
  return true;
}

export function removeAutoResponder(guildId, trigger) {
  const s = ensureGuild(guildId);
  if (!s.auto_responders) return false;
  const before = s.auto_responders.length;
  s.auto_responders = s.auto_responders.filter(a => a.trigger !== trigger.toLowerCase());
  save("guild_settings");
  return s.auto_responders.length < before;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE TOGGLES & AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════

// ─── Feature Toggles ────────────────────────────────────────────────────────

export function isFeatureEnabled(guildId, feature) {
  const s = data.guild_settings[guildId];
  if (!s) return true; // default enabled
  return s[`${feature}_enabled`] !== false;
}

export function setFeatureToggle(guildId, feature, enabled) {
  const s = ensureGuild(guildId);
  s[`${feature}_enabled`] = enabled;
  save("guild_settings");
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export function logAudit(guildId, action, userId, details) {
  const s = ensureGuild(guildId);
  if (!s.audit_log) s.audit_log = [];
  s.audit_log.push({
    action,
    userId,
    details,
    timestamp: new Date().toISOString(),
  });
  // Keep only last 100 entries per guild
  if (s.audit_log.length > 100) s.audit_log = s.audit_log.slice(-100);
  save("guild_settings");
}

// ═══════════════════════════════════════════════════════════════════════════
// INVITE TRACKING, TEMP BANS, INVITE FILTER & STICKY MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

// ─── INVITE TRACKING ───────────────────────────────────────────────────────

/** Record a new member join with invite data */
export function recordInviteJoin(guildId, userId, username, inviteCode, inviterId, inviterTag) {
  const s = ensureGuild(guildId);
  if (!s.invite_history) s.invite_history = [];
  s.invite_history.push({
    userId, username, inviteCode,
    inviterId: inviterId || null,
    inviterTag: inviterTag || null,
    timestamp: new Date().toISOString(),
    left: false,
    leftAt: null,
  });
  if (s.invite_history.length > 500) s.invite_history = s.invite_history.slice(-500);
  save("guild_settings");
}

/** Mark a member as having left the server */
export function markInviteLeave(guildId, userId) {
  const s = ensureGuild(guildId);
  if (!s.invite_history) return;
  // Mark the most recent join for this user
  for (let i = s.invite_history.length - 1; i >= 0; i--) {
    if (s.invite_history[i].userId === userId && !s.invite_history[i].left) {
      s.invite_history[i].left = true;
      s.invite_history[i].leftAt = new Date().toISOString();
      save("guild_settings");
      return;
    }
  }
}

/** Get recent invite join history */
export function getInviteHistory(guildId, limit = 20) {
  const s = ensureGuild(guildId);
  return (s.invite_history || []).slice(-limit).reverse();
}

/** Get invite leaderboard — top inviters with counts */
export function getInviteLeaderboard(guildId) {
  const s = ensureGuild(guildId);
  const history = s.invite_history || [];
  const counts = {};
  for (const entry of history) {
    if (!entry.inviterId) continue;
    if (!counts[entry.inviterId]) counts[entry.inviterId] = { tag: entry.inviterTag, total: 0, stayed: 0, left: 0 };
    counts[entry.inviterId].total++;
    if (entry.inviterTag) counts[entry.inviterId].tag = entry.inviterTag; // Keep latest tag
    if (entry.left) counts[entry.inviterId].left++;
    else counts[entry.inviterId].stayed++;
  }
  return Object.entries(counts)
    .map(([id, data]) => ({ userId: id, ...data }))
    .sort((a, b) => b.total - a.total);
}

/** Get all joins that came through a specific inviter */
export function getInvitesBy(guildId, userId) {
  const s = ensureGuild(guildId);
  return (s.invite_history || []).filter(e => e.inviterId === userId);
}

// ─── TEMP BANS ─────────────────────────────────────────────────────────────
export function addTempBan(guildId, userId, username, duration, reason, moderatorId) {
  const s = ensureGuild(guildId);
  if (!s.temp_bans) s.temp_bans = [];
  s.temp_bans.push({
    userId, username, reason,
    moderatorId,
    bannedAt: new Date().toISOString(),
    unbanAt: new Date(Date.now() + duration).toISOString(),
  });
  save("guild_settings");
}

export function getExpiredTempBans() {
  const now = new Date().toISOString();
  const expired = [];
  for (const [guildId, settings] of Object.entries(data.guild_settings)) {
    if (!settings.temp_bans?.length) continue;
    const due = settings.temp_bans.filter(b => b.unbanAt <= now);
    const remaining = settings.temp_bans.filter(b => b.unbanAt > now);
    if (due.length) {
      expired.push(...due.map(b => ({ ...b, guildId })));
      settings.temp_bans = remaining;
      _markEntity("guild_settings", guildId);
      save("guild_settings");
    }
  }
  return expired;
}

export function removeTempBan(guildId, userId) {
  const s = ensureGuild(guildId);
  if (!s.temp_bans) return;
  s.temp_bans = s.temp_bans.filter(b => b.userId !== userId);
  save("guild_settings");
}

// ─── INVITE FILTER ─────────────────────────────────────────────────────────
export function setInviteFilter(guildId, enabled) {
  const s = ensureGuild(guildId);
  s.invite_filter = enabled;
  save("guild_settings");
}

export function setInviteFilterWhitelist(guildId, roleIds) {
  const s = ensureGuild(guildId);
  s.invite_filter_whitelist = roleIds;
  save("guild_settings");
}

// ─── STICKY MESSAGES ───────────────────────────────────────────────────────
export function setStickyMessage(guildId, channelId, content, embedData) {
  const s = ensureGuild(guildId);
  if (!s.sticky_messages) s.sticky_messages = {};
  s.sticky_messages[channelId] = { content, embedData, lastMessageId: null };
  save("guild_settings");
}

export function getStickyMessage(guildId, channelId) {
  const s = ensureGuild(guildId);
  return s.sticky_messages?.[channelId] || null;
}

export function updateStickyMessageId(guildId, channelId, messageId) {
  const s = ensureGuild(guildId);
  if (s.sticky_messages?.[channelId]) {
    s.sticky_messages[channelId].lastMessageId = messageId;
    save("guild_settings");
  }
}

export function removeStickyMessage(guildId, channelId) {
  const s = ensureGuild(guildId);
  if (s.sticky_messages) {
    delete s.sticky_messages[channelId];
    save("guild_settings");
  }
}

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
      server_whitelist: {}, saved_queues: {}, giveaways: [], highlights: {},
      mood: { mood_score: 0, energy: 50 }, relationships: {}, temp_vcs: {},
    };
  },
};
