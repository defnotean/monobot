// ─── In-Memory Sliding-Window Rate Limiter ──────────────────────────────────
// Cheap per-key request limiter for endpoints where a full Redis/DO solution
// would be overkill. Stores a bounded ring of recent hit timestamps per key
// and rejects when the window's hit count meets the cap.
//
// Designed for the twin-bot use case: a handful of long-lived keys (one per
// signing identity / source IP), short windows (≤60s), modest limits (≤a few
// hundred per window). For high-cardinality keys or multi-process correctness
// reach for something with shared state.
//
// Usage:
//   const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
//   if (!limiter.allow(identity)) { return 429; }
//
// Eviction:
//   The store is bounded by `maxKeys` (default 1000). When a new key arrives
//   and the store is full, the entry with the oldest most-recent hit is
//   pruned. This is best-effort — it's not a security boundary against a
//   high-cardinality flooder, just a memory guard for normal operation.

const DEFAULT_MAX_KEYS = 1000;

/**
 * Create a sliding-window rate limiter.
 *
 * @param {object} opts
 * @param {number} opts.limit     Max allowed hits per window per key.
 * @param {number} opts.windowMs  Window length in ms.
 * @param {number} [opts.maxKeys=1000] Soft cap on tracked keys (memory guard).
 * @returns {{ allow: (key: string, now?: number) => boolean, reset: () => void, _size: () => number }}
 */
export function createRateLimiter({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS } = {}) {
  if (!Number.isFinite(limit) || limit < 1) throw new Error("rate limiter: limit must be a positive integer");
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("rate limiter: windowMs must be a positive integer");

  // key → number[] of recent hit timestamps (ms), oldest first.
  const hits = new Map();

  function prune(arr, now) {
    // In-place trim of entries older than the window.
    let i = 0;
    while (i < arr.length && now - arr[i] >= windowMs) i++;
    if (i > 0) arr.splice(0, i);
  }

  function evictOldest() {
    // Find the key with the oldest most-recent hit and drop it. O(n) over
    // keys but n is bounded by maxKeys, and this only fires on overflow.
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, arr] of hits) {
      const last = arr.length ? arr[arr.length - 1] : 0;
      if (last < oldestTs) {
        oldestTs = last;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) hits.delete(oldestKey);
  }

  return {
    /**
     * Record a hit for `key` and return whether it was allowed.
     * Hits over the cap still consume nothing (no further bookkeeping) — the
     * window slides naturally as old hits age out, so blocked callers
     * recover automatically.
     */
    allow(key, now = Date.now()) {
      if (typeof key !== "string" || !key) return true; // unkeyed traffic isn't rate-limited
      let arr = hits.get(key);
      if (!arr) {
        if (hits.size >= maxKeys) evictOldest();
        arr = [];
        hits.set(key, arr);
      } else {
        prune(arr, now);
      }
      if (arr.length >= limit) return false;
      arr.push(now);
      return true;
    },
    /** Test helper — drop all state. */
    reset() {
      hits.clear();
    },
    /** Test helper — current tracked-key count. */
    _size() {
      return hits.size;
    },
  };
}
