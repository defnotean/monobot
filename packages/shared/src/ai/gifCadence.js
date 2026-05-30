const NATURAL_GIF_COOLDOWN_MS = 60 * 60 * 1000 * 60; // 2.5 days
const lastNaturalGifAt = new Map();

const EXPLICIT_GIF_RE = /\b(gif|reaction gif|send .*gif|post .*gif|meme reaction)\b/i;
const DIRECT_ACTION_RE = /\b(?:do|send|show|give|hit|drop|post)\b.{0,30}\b(?:dab|dance|wave|shrug|facepalm|laugh|hug|kiss|slap|rickroll|griddy|quan)\b/i;

/** @param {string} [text] */
export function isExplicitGifRequest(text = "") {
  const value = String(text || "");
  return EXPLICIT_GIF_RE.test(value) || DIRECT_ACTION_RE.test(value);
}

/** @param {string} scope @param {number} [now] */
export function shouldAllowNaturalGif(scope, now = Date.now()) {
  const key = String(scope || "global");
  if (!lastNaturalGifAt.has(key)) return { allowed: true, retryAfterMs: 0 };
  const last = lastNaturalGifAt.get(key) || 0;
  if (now - last < NATURAL_GIF_COOLDOWN_MS) {
    return {
      allowed: false,
      retryAfterMs: NATURAL_GIF_COOLDOWN_MS - (now - last),
    };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/** @param {string} scope @param {number} [now] */
export function recordNaturalGif(scope, now = Date.now()) {
  lastNaturalGifAt.set(String(scope || "global"), now);
}

export function resetGifCadenceForTests() {
  lastNaturalGifAt.clear();
}
