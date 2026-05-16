// ─── Bump User Preferences ──────────────────────────────────────────────────
// Per-user opt-ins for bump-related DMs:
//   - personal_ping_enabled: receive a DM when your server is bumpable
//   - weekly_mvp_optout:     opt OUT of the weekly-MVP thank-you DM (default in)
//
// Supabase schema expected:
//   CREATE TABLE eris_bump_user_prefs (
//     user_id                text PRIMARY KEY,
//     personal_ping_enabled  boolean NOT NULL DEFAULT false,
//     weekly_mvp_optout      boolean NOT NULL DEFAULT false,
//     updated_at             timestamptz NOT NULL DEFAULT now()
//   );
//
// Irene uses `irene_bump_user_prefs`. Both bots keep independent preference
// lists — a user could want Eris DMs but not Irene DMs.
//
// Graceful degradation: if the table doesn't exist yet, every lookup returns
// defaults and every write silently no-ops so the rest of the bump pipeline
// still works.
//
// Bot-local deps (`getSupabase`, `log`) are injected via factory:
//
//   const prefs = createBumpUserPrefs({ getSupabase, log });
//   await prefs.getUserPrefs(userId, "eris");

const DEFAULT_PREFS = Object.freeze({
  personal_ping_enabled: false,
  weekly_mvp_optout: false,
});

const CACHE_TTL_MS = 5 * 60 * 1000;

function tableFor(botName) {
  return botName === "irene" ? "irene_bump_user_prefs" : "eris_bump_user_prefs";
}

function cacheKey(botName, userId) {
  return `${botName}:${userId}`;
}

const _noop = () => {};

/**
 * Build a bumpUserPrefs module bound to a specific bot's Supabase client + logger.
 *
 * @param {object} deps
 * @param {() => any} deps.getSupabase  Lazy getter for the Supabase client (or null).
 * @param {(msg: string) => void} [deps.log]  Optional logger. Defaults to no-op.
 */
export function createBumpUserPrefs({ getSupabase, log } = {}) {
  if (typeof getSupabase !== "function") {
    throw new Error("createBumpUserPrefs: getSupabase function is required");
  }
  const _log = typeof log === "function" ? log : _noop;

  // In-memory cache so we don't query Supabase for every DM loop.
  // key = `${botName}:${userId}` → prefs
  const _cache = new Map();

  // ─── Read ───────────────────────────────────────────────────────────────────

  async function getUserPrefs(userId, botName = "eris") {
    if (!userId) return { ...DEFAULT_PREFS };
    const key = cacheKey(botName, userId);
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return { ...cached.prefs };

    try {
      const sb = getSupabase();
      if (!sb) return { ...DEFAULT_PREFS };
      const { data, error } = await sb
        .from(tableFor(botName))
        .select("personal_ping_enabled, weekly_mvp_optout")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        // Table missing or transient — return defaults, don't cache the miss
        // indefinitely in case the migration runs later.
        _log(`[BumpPrefs] read failed: ${error.message}`);
        return { ...DEFAULT_PREFS };
      }
      const prefs = data ? { ...DEFAULT_PREFS, ...data } : { ...DEFAULT_PREFS };
      _cache.set(key, { prefs, fetchedAt: Date.now() });
      // Opportunistic LRU prune
      if (_cache.size > 5000) {
        const cutoff = Date.now() - CACHE_TTL_MS * 2;
        for (const [k, v] of _cache) if (v.fetchedAt < cutoff) _cache.delete(k);
      }
      return { ...prefs };
    } catch (e) {
      _log(`[BumpPrefs] getUserPrefs: ${e.message}`);
      return { ...DEFAULT_PREFS };
    }
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  /**
   * Upsert one pref for a user. Returns { ok: true } or { ok: false, error }.
   */
  async function setUserPref(userId, prefKey, value, botName = "eris") {
    if (!userId) return { ok: false, error: "userId required" };
    if (!["personal_ping_enabled", "weekly_mvp_optout"].includes(prefKey)) {
      return { ok: false, error: `unknown pref: ${prefKey}` };
    }
    try {
      const sb = getSupabase();
      if (!sb) return { ok: false, error: "no supabase" };
      const row = {
        user_id: userId,
        [prefKey]: !!value,
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from(tableFor(botName)).upsert(row);
      if (error) {
        _log(`[BumpPrefs] write failed: ${error.message}`);
        return { ok: false, error: error.message };
      }
      // Invalidate cache so next read reflects the write.
      _cache.delete(cacheKey(botName, userId));
      return { ok: true };
    } catch (e) {
      _log(`[BumpPrefs] setUserPref: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // ─── Bulk: all users who opted into personal pings ─────────────────────────
  // Used by the bump reminder to find who to DM when a timer fires. Filtered
  // by bot so Eris doesn't DM Irene's opt-ins or vice versa.

  async function getPersonalPingOptIns(botName = "eris") {
    try {
      const sb = getSupabase();
      if (!sb) return [];
      const { data, error } = await sb
        .from(tableFor(botName))
        .select("user_id")
        .eq("personal_ping_enabled", true);
      if (error) {
        _log(`[BumpPrefs] optins read failed: ${error.message}`);
        return [];
      }
      return (data || []).map(r => r.user_id);
    } catch (e) {
      _log(`[BumpPrefs] getPersonalPingOptIns: ${e.message}`);
      return [];
    }
  }

  // ─── Testing helpers ───────────────────────────────────────────────────────
  function _clearCache() { _cache.clear(); }

  return {
    getUserPrefs,
    setUserPref,
    getPersonalPingOptIns,
    _clearCache,
  };
}

export const _internal = { DEFAULT_PREFS, tableFor };
