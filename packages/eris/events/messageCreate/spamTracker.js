// ─── packages/eris/events/messageCreate/spamTracker.js ──────────────────────
// Repeat-message detection + warning-escalation tracker. Both the message
// tracker and the warning counter are module-scoped LRU/Maps so that every
// message goes through the same shared state without rebuilding on each
// import.

import { LRUCache } from "@defnotean/shared/LRUCache";

// Repeat message detection — mock users who spam the same thing.
// LRU+TTL so idle-user entries age out instead of accumulating via FIFO.
const _lastMessages = new LRUCache(5000, 10 * 60_000); // 10min TTL

export function trackMessage(guildId, userId, text) {
  const key = guildId + ":" + userId;
  const entry = _lastMessages.get(key);
  const now = Date.now();
  const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (entry && entry.text === normalized && now - entry.lastTime < 120000) {
    if (!entry.botResponded) return { count: 1 };
    entry.count++;
    entry.lastTime = now;
    entry.botResponded = false;
    _lastMessages.set(key, entry);
    return { count: entry.count };
  }
  _lastMessages.set(key, { text: normalized, count: 1, lastTime: now, botResponded: false });
  return { count: 1 };
}

export function markBotResponded(guildId, userId) {
  const key = guildId + ":" + userId;
  const entry = _lastMessages.get(key);
  if (entry) {
    entry.botResponded = true;
    _lastMessages.set(key, entry); // re-set to bump LRU recency
  }
}

// LRU-cap helper — trim Map to maxSize by evicting oldest entries
function _capMap(map, maxSize) {
  if (map.size <= maxSize) return;
  const excess = map.size - maxSize;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= excess) break;
    map.delete(key);
  }
}

// Warning tracker for escalating repeat spam
const _warnings = new Map(); // "guildId:userId" → { count, lastTime }

export function addWarning(guildId, userId) {
  const key = guildId + ":" + userId;
  const entry = _warnings.get(key);
  const now = Date.now();
  // Reset warnings after 10 minutes of no spam
  if (entry && now - entry.lastTime < 600000) {
    entry.count++;
    entry.lastTime = now;
    return entry.count;
  }
  _warnings.set(key, { count: 1, lastTime: now });
  _capMap(_warnings, 5000);
  return 1;
}

/** Jaccard word-level similarity between two strings (0..1). */
export function jaccardSim(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
