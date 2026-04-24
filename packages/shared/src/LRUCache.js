// ─── LRU Cache with Optional TTL ────────────────────────────────────────────
// Uses Map insertion order for eviction. On get(), entries move to the end
// (most recently used). On set() over capacity, the oldest entry is evicted.
//
// Optional group-key indexing: when set() is called with a third arg, the key
// is added to an index keyed by `group`, which lets deleteGroup(g) drop every
// key in that group in O(k) where k = keys in group (not total cache size).
// This exists so invalidateUserCache(userId) doesn't have to scan the whole
// cache for a prefix match — call set(key, value, userId) and then
// deleteGroup(userId) to clear it.

export class LRUCache {
  /**
   * @param {number} maxSize — maximum number of entries
   * @param {number} [ttlMs] — optional time-to-live in milliseconds (0 = no expiry)
   */
  constructor(maxSize, ttlMs = 0) {
    this._max = maxSize;
    this._ttl = ttlMs;
    this._map = new Map();
    // group → Set<key>. Populated only for entries set with a group.
    this._groups = new Map();
  }

  get size() { return this._map.size; }

  has(key) {
    if (!this._map.has(key)) return false;
    if (this._ttl && Date.now() - this._map.get(key).ts > this._ttl) {
      this._deleteWithGroup(key);
      return false;
    }
    return true;
  }

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
   * @param {string} key
   * @param {*}      value
   * @param {string} [group] — optional group id; enables O(1) deleteGroup(group).
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

  delete(key) { return this._deleteWithGroup(key); }

  /**
   * Drop every key in a group. O(k) where k = group size, independent of
   * total cache size. Returns the number of keys removed.
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
