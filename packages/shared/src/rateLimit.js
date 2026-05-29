/**
 * @file rateLimit.js
 * @module @monobot/shared/rateLimit
 *
 * @description
 * In-memory, sliding-window, per-key rate limiter intended for endpoints
 * where a full Redis / Durable Object solution would be overkill. Each key
 * tracks an in-place array of recent hit timestamps; a request is allowed
 * when the count of timestamps inside the trailing `windowMs` is below
 * `limit`, and rejected otherwise. The window slides naturally — stale
 * timestamps are pruned on every `allow()` call, so blocked callers recover
 * without any explicit "reset" tick.
 *
 * @summary Key exports
 *  - {@link createRateLimiter} — factory returning `{ allow, reset, _size }`.
 *
 * @summary Algorithm
 *  Sliding window with lazy pruning. For each `allow(key, now)`:
 *    1. Look up (or create) the timestamp array for `key`.
 *    2. Splice off entries older than `now - windowMs`.
 *    3. If the surviving array length is >= `limit`, return `false` (deny).
 *    4. Otherwise push `now` and return `true` (allow).
 *  This is O(hits-in-window) per call, not O(total-hits).
 *
 * @summary Memory bound (`maxKeys`)
 *  Tracked keys are capped by `maxKeys` (default 1000). On overflow the
 *  factory evicts the entry whose most-recent hit is the oldest — a cheap
 *  LRU-ish heuristic. This is a memory guard for normal traffic, not a
 *  security boundary against a high-cardinality flooder; a determined
 *  attacker can churn keys and force eviction of legitimate ones.
 *
 * @summary Scope caveat — per-process state
 *  All counters live in this Node process's heap. Two replicas behind a
 *  load balancer each enforce the limit independently, so the effective
 *  cap is roughly `limit × replicaCount`. Single-process deployments (the
 *  current MonoBot topology) are unaffected. If/when we horizontally scale
 *  the HTTP surface, swap this for a shared store (Redis INCR with TTL,
 *  Cloudflare Durable Object, etc.). See SCALING.md once that doc lands.
 *
 * @summary Where it's used
 *  - `packages/irene/presence.js` — gates `/api/twin/state` per signing
 *    identity so a misbehaving twin can't flood the presence channel.
 *  - `packages/eris/api/dashboard.js` — protects dashboard endpoints
 *    against per-IP brute force / scrape loops.
 *
 * @summary Suggested limits
 *  - Per-IP public read endpoint: `{ limit: 60, windowMs: 60_000 }`.
 *  - Per-identity webhook / twin push: `{ limit: 30, windowMs: 10_000 }`.
 *  - Per-user write/mutation: `{ limit: 10, windowMs: 60_000 }`.
 *  - Per-IP auth/login attempt: `{ limit: 5, windowMs: 60_000 }`.
 *  Tune by observing real traffic; start permissive and tighten.
 */

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
 * @param {number} [opts.globalLimit=0] Optional total accepted hits across all keys.
 * @param {number} [opts.globalWindowMs=windowMs] Window length for the global cap.
 * @returns {{ allow: (key: string, now?: number) => boolean, reset: () => void, _size: () => number, _globalSize: () => number }}
 */
export function createRateLimiter({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS, globalLimit = 0, globalWindowMs = windowMs } = /** @type {any} */ ({})) {
  if (!Number.isFinite(limit) || limit < 1) throw new Error("rate limiter: limit must be a positive integer");
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("rate limiter: windowMs must be a positive integer");
  if (!Number.isFinite(maxKeys) || maxKeys < 1) throw new Error("rate limiter: maxKeys must be a positive integer");
  if (!Number.isFinite(globalLimit) || globalLimit < 0) throw new Error("rate limiter: globalLimit must be a non-negative integer");
  if (globalLimit > 0 && (!Number.isFinite(globalWindowMs) || globalWindowMs < 1)) throw new Error("rate limiter: globalWindowMs must be a positive integer");

  // key → number[] of recent hit timestamps (ms), oldest first.
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  /** @type {number[]} */
  const globalHits = [];
  const hasGlobalCap = globalLimit > 0;

  /** @param {number[]} arr @param {number} now */
  function prune(arr, now, winMs = windowMs) {
    // In-place trim of entries older than the window.
    let i = 0;
    while (i < arr.length && now - arr[i] >= winMs) i++;
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
      if (hasGlobalCap) {
        prune(globalHits, now, globalWindowMs);
        if (globalHits.length >= globalLimit) return false;
      }
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
      if (hasGlobalCap) globalHits.push(now);
      return true;
    },
    /** Test helper — drop all state. */
    reset() {
      hits.clear();
      globalHits.length = 0;
    },
    /** Test helper — current tracked-key count. */
    _size() {
      return hits.size;
    },
    _globalSize() {
      return globalHits.length;
    },
  };
}
