// ─── Per-User Tool Rate Limiting ─────────────────────────────────────────────
const TOOL_LIMITS = {
  web_search: { max: 10, windowMs: 60_000 },
  scrape_url: { max: 5, windowMs: 60_000 },
  analyze_image: { max: 5, windowMs: 60_000 },
  search_images: { max: 10, windowMs: 60_000 },
  create_meme: { max: 5, windowMs: 60_000 },
  send_gif: { max: 10, windowMs: 60_000 },
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
