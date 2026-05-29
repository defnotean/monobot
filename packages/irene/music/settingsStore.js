// ─── packages/irene/music/settingsStore.js ─────────────────────────────────
// Durable store for per-guild music/voice settings that were previously
// in-memory-only and lost on every restart:
//   - soundboard  : { [soundName]: { url, category, duration } }
//   - djRole      : roleId string (or null = no DJ role requirement)
//   - wakeWord    : voice-listener wake word string
//
// Backed by a dedicated `music_settings` Supabase table (one row per guild,
// keyed on guild_id, payload in a jsonb `data` column — same shape as the
// per-entity tables). All READS are synchronous from an in-memory cache that
// is hydrated lazily the first time a guild is touched; WRITES update the
// cache immediately and flush to Supabase in the background.
//
// Degrades safely: if Supabase isn't connected (self-hosted without
// persistence) or the table/columns are absent, every operation falls back to
// the in-memory cache. Settings then behave exactly as before (lost on
// restart) but nothing throws.
//
// We do NOT touch database.js — we reuse its getSupabase() client only.

import { getSupabase } from "../database.js";
import { log } from "../utils/logger.js";

const TABLE = "music_settings";

// guildId → { soundboard: {}, djRole: null, wakeWord: undefined }
const _cache = new Map();
// guildIds we've already attempted to hydrate from Supabase (success or not)
// so a guild with no row doesn't re-query on every read.
const _hydrated = new Set();
// Set true once any Supabase read/write fails in a way that signals the table
// or columns are missing — after that we stop hammering it and stay in-memory.
let _degraded = false;

function _emptySettings() {
  return { soundboard: {}, djRole: null, wakeWord: undefined };
}

function _localGet(guildId) {
  let s = _cache.get(guildId);
  if (!s) {
    s = _emptySettings();
    _cache.set(guildId, s);
  }
  return s;
}

// Errors that mean "table/columns don't exist" — flip to degraded so we don't
// keep retrying a schema that was never applied. Supabase/PostgREST surfaces
// these as 42P01 (undefined_table) / 42703 (undefined_column) / PGRST205
// (relation not found in schema cache).
function _isSchemaMissing(error) {
  if (!error) return false;
  const code = error.code || "";
  if (code === "42P01" || code === "42703" || code === "PGRST205") return true;
  const msg = (error.message || "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("could not find the table");
}

/**
 * Ensure a guild's settings are loaded into the cache. Synchronous reads can
 * call this fire-and-forget; the value is returned to callers that await it.
 * Safe to call repeatedly — only the first call per guild hits Supabase.
 */
export async function loadGuild(guildId) {
  if (_hydrated.has(guildId)) return _localGet(guildId);
  _hydrated.add(guildId); // mark first so concurrent callers don't double-fetch

  const supabase = getSupabase();
  if (!supabase || _degraded) return _localGet(guildId);

  try {
    const { data: row, error } = await supabase
      .from(TABLE)
      .select("data")
      .eq("guild_id", guildId)
      .maybeSingle();

    if (error) {
      if (_isSchemaMissing(error)) {
        _degraded = true;
        log(`[MusicSettings] Table "${TABLE}" missing — running in-memory only`);
      } else {
        // Transient (non-schema) failure — un-hydrate so a later read can
        // retry and pick up the real row instead of serving empty defaults
        // for this process's entire lifetime.
        _hydrated.delete(guildId);
        log(`[MusicSettings] Load failed for ${guildId}: ${error.message}`);
      }
      return _localGet(guildId);
    }

    const loaded = row?.data;
    if (loaded && typeof loaded === "object") {
      const s = _localGet(guildId);
      if (loaded.soundboard && typeof loaded.soundboard === "object") s.soundboard = loaded.soundboard;
      if ("djRole" in loaded) s.djRole = loaded.djRole ?? null;
      if ("wakeWord" in loaded) s.wakeWord = loaded.wakeWord ?? undefined;
    }
  } catch (err) {
    // Transient throw (e.g. network) — un-hydrate so a later read retries.
    _hydrated.delete(guildId);
    log(`[MusicSettings] Load error for ${guildId}: ${err.message}`);
  }
  return _localGet(guildId);
}

// Background flush — never throws. Upserts the whole settings blob for one guild.
function _persist(guildId) {
  const supabase = getSupabase();
  if (!supabase || _degraded) return;
  const s = _localGet(guildId);
  const payload = { soundboard: s.soundboard, djRole: s.djRole, wakeWord: s.wakeWord };
  Promise.resolve()
    .then(() =>
      supabase
        .from(TABLE)
        .upsert({ guild_id: guildId, data: payload, updated_at: new Date().toISOString() }, { onConflict: "guild_id" })
    )
    .then(({ error } = {}) => {
      if (error) {
        if (_isSchemaMissing(error)) {
          _degraded = true;
          log(`[MusicSettings] Table "${TABLE}" missing — running in-memory only`);
        } else {
          log(`[MusicSettings] Save failed for ${guildId}: ${error.message}`);
        }
      }
    })
    .catch((err) => log(`[MusicSettings] Save error for ${guildId}: ${err.message}`));
}

// ─── Soundboard ──────────────────────────────────────────────────────────────

/** Synchronous read of the cached soundboard map for a guild. */
export function getSoundboard(guildId) {
  return _localGet(guildId).soundboard;
}

/** Replace the soundboard map for a guild and persist. */
export function setSoundboard(guildId, sounds) {
  _localGet(guildId).soundboard = sounds || {};
  _persist(guildId);
}

// ─── DJ role ───────────────────────────────────────────────────────────────

export function getDjRole(guildId) {
  return _localGet(guildId).djRole ?? null;
}

export function setDjRole(guildId, roleId) {
  _localGet(guildId).djRole = roleId ?? null;
  _persist(guildId);
}

// ─── Wake word ─────────────────────────────────────────────────────────────
// Returns undefined when unset so callers can apply their own default.

export function getWakeWord(guildId) {
  return _localGet(guildId).wakeWord;
}

export function setWakeWord(guildId, word) {
  _localGet(guildId).wakeWord = word;
  _persist(guildId);
}

// ─── Test / shutdown helpers ─────────────────────────────────────────────────

/** Reset all in-memory state — used by tests to isolate cases. */
export function _resetForTest() {
  _cache.clear();
  _hydrated.clear();
  _degraded = false;
}

/** Whether the store has fallen back to in-memory-only mode. */
export function isDegraded() {
  return _degraded;
}
