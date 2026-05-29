/**
 * @file lruCache.js
 * @module @defnotean/shared/lruCache
 *
 * Bounded Least-Recently-Used (LRU) cache with optional time-to-live (TTL)
 * expiry and an optional secondary "group" index for bulk invalidation.
 *
 * ## Purpose
 * A lightweight in-memory cache with a hard upper bound on entry count, so
 * long-running processes (the Discord gateway worker, the AI service) can
 * memoize hot reads without unbounded heap growth. Backed by a single Map,
 * leveraging its insertion-ordered iteration to implement LRU eviction in
 * O(1) per access.
 *
 * ## Key exports
 * - `LRUCache` — the class. Construct with `new LRUCache(maxSize, ttlMs?)`.
 *   API surface: `get`, `set`, `has`, `delete`, `deleteGroup`, `clear`,
 *   `keys`, `values`, `size`, and `[Symbol.iterator]`.
 *
 * ## Eviction semantics
 * - On `get(key)`, a hit moves the entry to the tail of the Map (most
 *   recently used). The head is therefore always the least recently used.
 * - On `set(key, value)` when `size === maxSize` and the key is new, the
 *   head entry is evicted before the new one is appended.
 * - On `set(key, value)` for an existing key, the old entry is removed and
 *   re-inserted so the key's position resets to the tail (touch-on-write).
 *
 * ## TTL behavior
 * - TTL is millisecond-precision and uses `Date.now()` (wall clock, not a
 *   monotonic source). System clock jumps will skew expiry; this is
 *   acceptable for the use cases here (short-lived web/API caches).
 * - Expiry is checked lazily on `get`, `has`, and iteration. Expired entries
 *   are not actively swept — a stale entry that is never touched again will
 *   sit in the Map until eviction pressure displaces it.
 * - Pass `ttlMs = 0` (the default) to disable TTL entirely.
 *
 * ## Thread-safety / concurrency
 * Node runs JS on a single event-loop thread, so no operation can interleave
 * with another mid-method. This class is NOT safe across worker_threads,
 * cluster workers, or multiple processes — each isolate gets its own
 * instance. For cross-process coordination use Redis or a shared store.
 *
 * ## When to use vs. a plain Map
 * Use `LRUCache` when entries must be bounded (memoization of user lookups,
 * AI response caches, etc.). Use a plain `Map` when the key set is naturally
 * bounded by the program (config tables, registry maps) or when you need
 * exact insertion-ordered iteration without eviction side effects.
 *
 * ## Memory footprint
 * Per entry overhead is roughly: one Map slot (~50–80 B on V8) plus the
 * wrapper object `{ value, ts, group }` (~40 B). At `maxSize = 1000` with
 * small values, expect on the order of ~100 KB of overhead beyond the
 * payload. Group index adds one Set entry (~40 B) per grouped key.
 *
 * @see packages/eris/tests/utils/lruCache.test.ts for behavioral specs.
 */

// Optional group-key indexing: when set() is called with a third arg, the key
// is added to an index keyed by `group`, which lets deleteGroup(g) drop every
// key in that group in O(k) where k = keys in group (not total cache size).
// This exists so invalidateUserCache(userId) doesn't have to scan the whole
// cache for a prefix match — call set(key, value, userId) and then
// deleteGroup(userId) to clear it.

export class LRUCache {
  /**
   * @param {number} maxSize - maximum number of entries
   * @param {number} [ttlMs] - optional time-to-live in milliseconds (0 = no expiry)
   */
  constructor(maxSize, ttlMs = 0) {
    this._max = maxSize;
    this._ttl = ttlMs;
    this._map = new Map();
    // group → Set<key>. Populated only for entries set with a group.
    this._groups = new Map();
  }

  get size() { return this._map.size; }

  /** @param {any} key */
  has(key) {
    if (!this._map.has(key)) return false;
    if (this._ttl && Date.now() - this._map.get(key).ts > this._ttl) {
      this._deleteWithGroup(key);
      return false;
    }
    return true;
  }

  /** @param {any} key */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (this._ttl && Date.now() - entry.ts > this._ttl) {
      this._deleteWithGroup(key);
      return undefined;
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * @param {any} key
   * @param {*}      value
   * @param {string} [group] - optional group id; enables O(1) deleteGroup(group).
   */
  set(key, value, group) {
    // Remove existing to update position (also clean any stale group index)
    if (this._map.has(key)) this._deleteWithGroup(key);
    // Evict oldest if at capacity
    if (this._map.size >= this._max) {
      const oldest = this._map.keys().next().value;
      this._deleteWithGroup(oldest);
    }
    this._map.set(key, { value, ts: Date.now(), group: group ?? null });
    if (group != null) {
      let set = this._groups.get(group);
      if (!set) { set = new Set(); this._groups.set(group, set); }
      set.add(key);
    }
    return this;
  }

  /** @param {any} key */
  delete(key) { return this._deleteWithGroup(key); }

  /**
   * Drop every key in a group. O(k) where k = group size, independent of
   * total cache size. Returns the number of keys removed.
   * @param {string} group
   */
  deleteGroup(group) {
    if (group == null) return 0;
    const set = this._groups.get(group);
    if (!set) return 0;
    let removed = 0;
    for (const key of set) {
      if (this._map.delete(key)) removed++;
    }
    this._groups.delete(group);
    return removed;
  }

  clear() { this._map.clear(); this._groups.clear(); }

  /** Iterate over [key, value] pairs (newest last). */
  *[Symbol.iterator]() {
    for (const [key, entry] of this._map) {
      if (this._ttl && Date.now() - entry.ts > this._ttl) {
        this._deleteWithGroup(key);
        continue;
      }
      yield [key, entry.value];
    }
  }

  keys() {
    return [...this._map.keys()];
  }

  values() {
    return [...this].map(([, v]) => v);
  }

  // ─── Internals ─────────────────────────────────────────────────────────
  /** @param {any} key */
  _deleteWithGroup(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    this._map.delete(key);
    if (entry.group != null) {
      const set = this._groups.get(entry.group);
      if (set) {
        set.delete(key);
        if (set.size === 0) this._groups.delete(entry.group);
      }
    }
    return true;
  }
}
