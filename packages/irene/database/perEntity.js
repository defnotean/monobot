// ─── Per-Entity Persistence Layer — Phase 1 ──────────────────────────────────
//
// Replacement for the single-row blob in database.js's _flushSave. Each helper
// targets ONE table created in migrations/20260427033429-per-entity-tables.sql
// and writes ONE row per natural key (guild_id for per-guild tables, bot_name
// for global tables).
//
// Features:
//   - Optimistic concurrency via the table's `version` column. Each write
//     reads the current version, attempts an update with .eq("version", v),
//     and bumps version+1 on success. On conflict (somebody else won the
//     race) we re-read and retry — up to 3 attempts total.
//   - Per-entity-key coalescing: rapid writes to the same (table, key) inside
//     a 500 ms window collapse into one Supabase call carrying the latest
//     data. Different keys / different tables never block each other.
//   - Insert-or-update: if no row exists yet we insert with version=1. If a
//     concurrent insert beats us we fall through to update on the next retry.
//
// Public surface (one helper per table):
//   writeGuildSettings(guildId, data)
//   writeCustomCommands(guildId, data)
//   writeScrimStats(guildId, data)
//   writeStarboardEntries(guildId, data)
//   writeSavedQueue(guildId, data)
//   writeMoodState(data)
//   writeRelationships(data)
//   writeGlobalState(data)
//
// Each returns a Promise that resolves once the (eventually-coalesced) write
// lands. Callers don't await it on the hot path — fire-and-forget is fine.
// On shutdown call flushPerEntityNow() to drain the coalesce timers.

import { getSupabase } from "../database.js";
import config from "../config.js";
import { log } from "../utils/logger.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const COALESCE_MS = 500;
const MAX_RETRIES = 3;

// ─── Internal state — coalesce timers, in-flight promises ────────────────────
//
// Keyed by `${table}:${key}`. Each entry:
//   { timer, latestData, pending }   — timer is the setTimeout handle,
//   latestData is the freshest payload submitted during the window,
//   pending is the Promise that will resolve once the write lands.

const _coalesce = new Map();

function _coalesceKey(table, key) {
  return `${table}:${key}`;
}

// ─── Optimistic concurrency core ─────────────────────────────────────────────
//
// Performs one write attempt cycle for a (table, keyColumn, keyValue). Reads
// the current row, then either updates with version-check or inserts fresh.
// Returns true on success, false if a version conflict happened (caller should
// retry). Throws on actual errors.

async function _attemptWrite(supabase, table, keyColumn, keyValue, data) {
  // 1. Read current row to learn the version.
  const { data: existing, error: readErr } = await supabase
    .from(table)
    .select("version")
    .eq(keyColumn, keyValue)
    .maybeSingle();

  if (readErr) throw new Error(`[perEntity] read ${table} failed: ${readErr.message}`);

  if (!existing) {
    // No row yet — insert with version=1. If someone else inserted first this
    // returns a unique-violation; treat that as a version conflict and retry.
    const { error: insertErr } = await supabase
      .from(table)
      .insert({ [keyColumn]: keyValue, version: 1, data, updated_at: new Date().toISOString() });
    if (!insertErr) return true;
    // 23505 = unique_violation in Postgres. Anything else is a real failure.
    if (insertErr.code === "23505") return false;
    throw new Error(`[perEntity] insert ${table} failed: ${insertErr.message}`);
  }

  // 2. Update with version check. .eq("version", currentVersion) means rows
  //    where someone else has bumped the version since we read it WON'T match
  //    and we get an empty .data back → version conflict, retry.
  const currentVersion = existing.version;
  const { data: updated, error: updateErr } = await supabase
    .from(table)
    .update({ version: currentVersion + 1, data, updated_at: new Date().toISOString() })
    .eq(keyColumn, keyValue)
    .eq("version", currentVersion)
    .select("version");

  if (updateErr) throw new Error(`[perEntity] update ${table} failed: ${updateErr.message}`);
  // Empty array = no row matched the version check = lost the race.
  if (!Array.isArray(updated) || updated.length === 0) return false;
  return true;
}

// ─── Retry wrapper — up to MAX_RETRIES attempts ──────────────────────────────

async function _writeWithRetry(table, keyColumn, keyValue, data) {
  const supabase = getSupabase();
  if (!supabase) {
    // Mirrors database.js's behavior: discard silently when Supabase isn't
    // wired up so tests / dev without credentials don't crash.
    return;
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ok = await _attemptWrite(supabase, table, keyColumn, keyValue, data);
      if (ok) return;
      // Soft conflict — fall through to retry without a backoff (Supabase
      // already round-tripped, we can immediately re-read).
      lastErr = new Error(`version conflict on ${table}/${keyValue}`);
    } catch (err) {
      lastErr = err;
      // Hard error — short backoff before retrying so transient glitches
      // (network blips, Supabase restarts) get a chance to clear.
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  log(`[perEntity] giving up after ${MAX_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`);
}

// ─── Coalescing scheduler ────────────────────────────────────────────────────
//
// schedule(table, keyColumn, keyValue, data):
//   - If no timer exists for this (table, key), creates one that fires after
//     COALESCE_MS and runs the write with the most recent data.
//   - If a timer ALREADY exists, just updates `latestData` so the pending
//     write picks up the fresh value when it fires. Does NOT reset the timer
//     — that would let a sustained write loop starve out the flush forever.
//
// Returns a promise that resolves once the eventual write lands.

function _schedule(table, keyColumn, keyValue, data) {
  const ck = _coalesceKey(table, keyValue);
  const existing = _coalesce.get(ck);
  if (existing) {
    existing.latestData = data;
    return existing.pending;
  }
  /** @type {(value?: any) => void} */
  let resolveOuter = () => {};
  const pending = new Promise((resolve) => { resolveOuter = resolve; });
  /** @type {{ timer: ReturnType<typeof setTimeout> | null, latestData: any, pending: Promise<any>, resolve: (value?: any) => void, keyColumn: any }} */
  const entry = {
    timer: null,
    latestData: data,
    pending,
    resolve: resolveOuter,
    keyColumn,
  };
  entry.timer = setTimeout(async () => {
    _coalesce.delete(ck);
    try {
      await _writeWithRetry(table, keyColumn, keyValue, entry.latestData);
    } finally {
      entry.resolve();
    }
  }, COALESCE_MS);
  _coalesce.set(ck, entry);
  return pending;
}

// ─── Public helpers — one per table ──────────────────────────────────────────

export function writeGuildSettings(guildId, data) {
  return _schedule("irene_guild_settings", "guild_id", String(guildId), data ?? {});
}

export function writeCustomCommands(guildId, data) {
  return _schedule("irene_custom_commands", "guild_id", String(guildId), data ?? {});
}

export function writeScrimStats(guildId, data) {
  return _schedule("irene_scrim_stats", "guild_id", String(guildId), data ?? {});
}

export function writeStarboardEntries(guildId, data) {
  return _schedule("irene_starboard_entries", "guild_id", String(guildId), data ?? {});
}

export function writeSavedQueue(guildId, data) {
  return _schedule("irene_saved_queue", "guild_id", String(guildId), data ?? {});
}

export function writeMoodState(data) {
  return _schedule("irene_mood_state", "bot_name", config.botName, data ?? {});
}

export function writeRelationships(data) {
  return _schedule("irene_relationships", "bot_name", config.botName, data ?? {});
}

export function writeGlobalState(data) {
  return _schedule("irene_global_state", "bot_name", config.botName, data ?? {});
}

// ─── Drain — call on shutdown to flush any pending coalesced writes ─────────
//
// Cancels all coalesce timers and runs every pending write immediately, then
// resolves once all of them land (or fail their retries). After this returns
// the coalesce map is empty.

export async function flushPerEntityNow() {
  const entries = [..._coalesce.entries()];
  _coalesce.clear();
  await Promise.all(entries.map(async ([ck, entry]) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const sepIdx = ck.indexOf(":");
    const table = ck.slice(0, sepIdx);
    const keyValue = ck.slice(sepIdx + 1);
    try {
      await _writeWithRetry(table, entry.keyColumn, keyValue, entry.latestData);
    } finally {
      entry.resolve();
    }
  }));
}

// ─── Test-only internals ─────────────────────────────────────────────────────
// Exposed so tests can reset state and inspect timing without Supabase.

export const _internal = {
  COALESCE_MS,
  MAX_RETRIES,
  _coalesce,
  _attemptWrite,
  _writeWithRetry,
  _schedule,
  __resetForTest() {
    for (const entry of _coalesce.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    _coalesce.clear();
  },
};
