// ─── Per-User Tool Rate Limiting ─────────────────────────────────────────────
// Sliding-window per-user caps on expensive / abusable tools. Without these,
// a single user can drain a paid API quota or queue up unbounded TTS playback
// for the whole guild. Caps are intentionally generous — they exist to catch
// runaway loops and obvious abuse, not to gate normal conversation.
const TOOL_LIMITS = {
  web_search:     { max: 10, windowMs: 60_000 },
  scrape_url:     { max: 5,  windowMs: 60_000 },
  analyze_image:  { max: 5,  windowMs: 60_000 },
  search_images:  { max: 10, windowMs: 60_000 },
  create_meme:    { max: 5,  windowMs: 60_000 },
  send_gif:       { max: 10, windowMs: 60_000 },
  // Image generation hits Gemini's image endpoint — each call costs us
  // money and the model is slow. 5/min/user keeps cost predictable.
  generate_image: { max: 5,  windowMs: 60_000 },
  // TTS queues audio in a voice channel — a user spamming this can hijack
  // the bot's voice for everyone in the VC. 10/min is plenty for normal
  // back-and-forth without being a denial-of-voice vector.
  say_tts:        { max: 10, windowMs: 60_000 },
};
const _windows = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of _windows) {
    const limit = TOOL_LIMITS[key.split(":")[1]];
    if (!limit) { _windows.delete(key); continue; }
    const filtered = times.filter(t => now - t < limit.windowMs);
    if (filtered.length === 0) _windows.delete(key);
    else _windows.set(key, filtered);
  }
}, 300_000);
export function checkToolRateLimit(userId, toolName) {
  const limit = TOOL_LIMITS[toolName];
  if (!limit) return { allowed: true };
  const key = `${userId}:${toolName}`;
  const now = Date.now();
  const times = (_windows.get(key) || []).filter(t => now - t < limit.windowMs);
  if (times.length >= limit.max) {
    const oldest = times[0];
    return { allowed: false, retryAfterMs: limit.windowMs - (now - oldest) };
  }
  times.push(now);
  _windows.set(key, times);
  return { allowed: true };
}
