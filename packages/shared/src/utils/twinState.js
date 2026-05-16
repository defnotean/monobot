// ─── Cross-Bot State Awareness ──────────────────────────────────────────────
// When Eris mentions Irene (or vice versa), pull the twin's actual current
// mood, energy, and preoccupation so references are grounded instead of
// hallucinated.
//
// Uses a simple GET /api/twin/state with Bearer TWIN_API_SECRET since this
// endpoint is side-effect-free. All fetches are cached for 5 minutes to
// avoid hammering the twin on every chatty message. Failures degrade
// silently — if the twin is offline, this module returns an empty context
// fragment and nothing else changes.
//
// The twin secret + URL are bot-local (Eris talks to Irene, Irene talks to
// Eris), so this module takes them via a factory:
//
//   const twinState = createTwinState({ getSecret, getUrl, log });
//   await twinState.buildTwinStateContext(text, { twinName: "irene" });

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const _noop = () => {};

/**
 * Build a twin-state client bound to a specific bot's config + logger.
 *
 * @param {object} deps
 * @param {() => string | undefined} deps.getSecret
 *   Lazy getter for the Bearer secret. Called on every fetch so config
 *   reloads or test-time env changes pick up without re-instantiation.
 * @param {() => string | undefined} deps.getUrl
 *   Lazy getter for the twin's base URL (no trailing slash).
 * @param {(msg: string) => void} [deps.log]  Optional logger. Defaults to no-op.
 */
export function createTwinState({ getSecret, getUrl, log } = {}) {
  if (typeof getSecret !== "function" || typeof getUrl !== "function") {
    throw new Error("createTwinState: getSecret and getUrl functions are required");
  }
  const _log = typeof log === "function" ? log : _noop;
  let _cache = null; // { state, fetchedAt } | { error, fetchedAt }

  async function getTwinStateCached({ force = false } = {}) {
    const now = Date.now();
    if (!force && _cache && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache;

    const secret = getSecret();
    const url = getUrl();
    if (!secret || !url) {
      _cache = { error: "twin api not configured", fetchedAt: now };
      return _cache;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/api/twin/state`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${secret}` },
        signal: abort.signal,
      });
      if (!res.ok) {
        _cache = { error: `twin state ${res.status}`, fetchedAt: now };
        return _cache;
      }
      const data = await res.json();
      _cache = { state: data, fetchedAt: now };
      return _cache;
    } catch (e) {
      _log(`[TwinState] Fetch failed: ${e.message}`);
      _cache = { error: e.message, fetchedAt: now };
      return _cache;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build a tiny context fragment about the twin's current state. Only returns
   * content when the user's message actually mentions the twin — otherwise
   * there's no reason to spend prompt budget on it.
   */
  async function buildTwinStateContext(messageText, { twinName = "irene" } = {}) {
    if (!messageText) return "";
    const lower = messageText.toLowerCase();
    if (!new RegExp(`\\b${twinName.toLowerCase()}\\b`).test(lower)) return "";

    const result = await getTwinStateCached();
    if (result?.error || !result?.state) return "";

    const s = result.state;
    const parts = [];
    if (typeof s.mood_score === "number") {
      const label = s.mood_score >= 30 ? "in a good mood"
        : s.mood_score >= 10 ? "doing ok"
        : s.mood_score >= -10 ? "neutral"
        : s.mood_score >= -30 ? "a little off"
        : "in a bad mood";
      parts.push(label);
    }
    if (typeof s.energy === "number") {
      if (s.energy > 70) parts.push("high energy");
      else if (s.energy < 25) parts.push("running low on energy");
    }
    if (s.preoccupation?.topic) {
      parts.push(`been into "${s.preoccupation.topic}" lately`);
    }
    if (!parts.length) return "";

    return `[TWIN STATE — ${twinName} right now: ${parts.join(", ")}. use this to ground any reference to her in reality; don't invent her mood or interests when you can just check.]`;
  }

  // Testing helper
  function _clearCache() { _cache = null; }

  return {
    getTwinStateCached,
    buildTwinStateContext,
    _clearCache,
  };
}
