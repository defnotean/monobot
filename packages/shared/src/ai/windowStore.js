// ─── Sliding-window store ─────────────────────────────────────────────────
// Item #20 from the council roadmap: makes the per-user split-payload window
// pluggable so a Redis-backed implementation can be dropped in for multi-
// replica deployments without touching the firewall.
//
// Interface (any implementation must provide):
//   async add(userId, text):        record a message in the user's window
//   async concat(userId): string|null   return last-N concatenated text or null
//
// The default in-memory implementation matches the previous behavior exactly:
// last 5 messages, 30s TTL, soft cap of 500 users with stale-first eviction.

export class InMemoryWindowStore {
  /** @param {{ winSize?: number, winTtlMs?: number, maxUsers?: number }} [opts] */
  constructor({ winSize = 5, winTtlMs = 30000, maxUsers = 500 } = {}) {
    this._winSize = winSize;
    this._winTtlMs = winTtlMs;
    this._maxUsers = maxUsers;
    /** @type {Map<string, { text: string, ts: number }[]>} */
    this._map = new Map();
  }

  /** @param {string} userId @param {string} text */
  async add(userId, text) {
    if (!userId) return;
    const now = Date.now();
    if (!this._map.has(userId)) this._map.set(userId, []);
    const win = /** @type {{ text: string, ts: number }[]} */ (this._map.get(userId));
    while (win.length && now - win[0].ts > this._winTtlMs) win.shift();
    win.push({ text, ts: now });
    while (win.length > this._winSize) win.shift();
    if (this._map.size > this._maxUsers) {
      for (const [k, v] of this._map) {
        if (!v.length || now - v[v.length - 1].ts > this._winTtlMs) this._map.delete(k);
      }
      if (this._map.size > this._maxUsers) {
        const overflow = this._map.size - this._maxUsers;
        let dropped = 0;
        for (const k of this._map.keys()) {
          if (dropped >= overflow) break;
          this._map.delete(k);
          dropped++;
        }
      }
    }
  }

  /** @param {string} userId */
  async concat(userId) {
    if (!userId) return null;
    const win = this._map.get(userId);
    return (win && win.length >= 2) ? win.map(w => w.text).join(" ") : null;
  }

  /** @param {string} [userId] */
  async clear(userId) {
    if (userId) this._map.delete(userId);
    else this._map.clear();
  }

  // Test/introspection
  _size() { return this._map.size; }
}

/**
 * Reference Redis adapter shape — not imported by default, written here so a
 * downstream consumer knows the contract. Keys are `firewall:win:{userId}`,
 * values are JSON arrays of `{text, ts}` objects with the matching TTL.
 *
 * Sketch only — uncomment + wire your Redis client to use:
 *
 *   import { createClient } from "redis";
 *   const r = createClient(); await r.connect();
 *   const store = new RedisWindowStore(r);
 *   const fw = createFirewall({ ..., windowStore: store });
 *
 * Multi-replica safety: Redis ops are atomic, so all replicas see a coherent
 * window for a given userId — closing the council's "split across replicas"
 * bypass.
 */
export class RedisWindowStore {
  /** @param {any} redisClient @param {{ winSize?: number, winTtlMs?: number, prefix?: string }} [opts] */
  constructor(redisClient, { winSize = 5, winTtlMs = 30000, prefix = "firewall:win:" } = {}) {
    this._r = redisClient;
    this._winSize = winSize;
    this._winTtlMs = winTtlMs;
    this._prefix = prefix;
  }
  /** @param {string} userId */
  _key(userId) { return this._prefix + userId; }

  /** @param {string} userId @param {string} text */
  async add(userId, text) {
    if (!userId) return;
    const k = this._key(userId);
    const entry = JSON.stringify({ text, ts: Date.now() });
    // RPUSH then LTRIM to enforce window size; PEXPIRE refreshes TTL.
    await this._r.rPush(k, entry);
    await this._r.lTrim(k, -this._winSize, -1);
    await this._r.pExpire(k, this._winTtlMs);
  }

  /** @param {string} userId */
  async concat(userId) {
    if (!userId) return null;
    const items = await this._r.lRange(this._key(userId), 0, -1);
    if (!items || items.length < 2) return null;
    const now = Date.now();
    const fresh = items
      .map((/** @type {string} */ s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((/** @type {any} */ e) => e && now - e.ts <= this._winTtlMs);
    return (fresh.length >= 2) ? fresh.map((/** @type {any} */ e) => e.text).join(" ") : null;
  }

  /** @param {string} [userId] */
  async clear(userId) {
    if (userId) await this._r.del(this._key(userId));
  }
}
