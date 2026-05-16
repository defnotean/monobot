// ai/keyPool.js — Smart API key pool with per-key rate-limit tracking
//
// Each key tracks its own rate-limit state. Round-robin skips limited keys.
// If ALL keys are limited, uses the one that recovers soonest.
//
// Originally lived in each bot's `ai/` directory. After the shared-logger
// migration, the only bot-local dependency was the logger import — so the
// module moves here and accepts an injected `log` instead. Callers wire
// their bot's logger in via the `{ log }` option on `createSplitPools()` /
// the KeyPool constructor; if omitted, a no-op suppresses output (so
// console-less unit tests don't crash).

const _noop = () => {};

export class KeyPool {
  /**
   * @param {string} name — pool label, surfaced in log lines.
   * @param {string[]} keys — array of API keys.
   * @param {new (opts: { apiKey: string }) => any} ClientClass — provider client.
   * @param {{ log?: (m: string) => void }} [opts]
   */
  constructor(name, keys, ClientClass, opts = {}) {
    this.name = name;
    this._log = opts.log || _noop;
    this.clients = keys.map((key, i) => ({
      id: i,
      client: new ClientClass({ apiKey: key }),
      rateLimitedUntil: 0,  // timestamp when this key becomes available again
      requestCount: 0,       // total requests served
      errorCount: 0,         // consecutive errors
      lastUsed: 0,
    }));
    this._idx = 0;
    this._log(`[KeyPool:${name}] Initialized with ${this.clients.length} keys`);
  }

  // Get the next available client, skipping rate-limited keys
  get() {
    if (this.clients.length === 0) return null;
    const now = Date.now();

    // Try to find an available (non-rate-limited) key via round-robin
    for (let i = 0; i < this.clients.length; i++) {
      const idx = (this._idx + i) % this.clients.length;
      const entry = this.clients[idx];
      if (entry.rateLimitedUntil <= now) {
        this._idx = idx + 1;
        entry.requestCount++;
        entry.lastUsed = now;
        return entry.client;
      }
    }

    // All keys are rate-limited — use the one that recovers soonest
    const soonest = this.clients.reduce((best, entry) =>
      entry.rateLimitedUntil < best.rateLimitedUntil ? entry : best
    );
    const waitMs = soonest.rateLimitedUntil - now;
    this._log(`[KeyPool:${this.name}] All ${this.clients.length} keys rate-limited. Soonest recovery: ${Math.ceil(waitMs / 1000)}s (key ${soonest.id})`);
    soonest.requestCount++;
    soonest.lastUsed = now;
    return soonest.client;
  }

  // Mark a specific client as rate-limited
  markRateLimited(client, durationMs = 60_000) {
    const entry = this.clients.find(e => e.client === client);
    if (entry) {
      entry.rateLimitedUntil = Date.now() + durationMs;
      entry.errorCount++;
      this._log(`[KeyPool:${this.name}] Key ${entry.id} rate-limited for ${Math.ceil(durationMs / 1000)}s (${entry.errorCount} errors total)`);
    }
  }

  // Mark a successful request (resets error count)
  markSuccess(client) {
    const entry = this.clients.find(e => e.client === client);
    if (entry) entry.errorCount = 0;
  }

  // Check if ALL keys are currently rate-limited
  allLimited() {
    const now = Date.now();
    return this.clients.every(e => e.rateLimitedUntil > now);
  }

  // Get pool stats for debugging
  stats() {
    const now = Date.now();
    return {
      total: this.clients.length,
      available: this.clients.filter(e => e.rateLimitedUntil <= now).length,
      limited: this.clients.filter(e => e.rateLimitedUntil > now).length,
      keys: this.clients.map(e => ({
        id: e.id,
        available: e.rateLimitedUntil <= now,
        requests: e.requestCount,
        errors: e.errorCount,
        limitedFor: e.rateLimitedUntil > now ? Math.ceil((e.rateLimitedUntil - now) / 1000) + "s" : null,
      })),
    };
  }

  get size() { return this.clients.length; }
}

// ─── Split pool into conversation + worker with per-key tracking ────────────

/**
 * Build three sub-pools off a single key list:
 *   - `conv` — even-indexed keys, biased toward conversational turns
 *   - `work` — odd-indexed keys, biased toward background / task tools
 *   - `all`  — every key (use when both classes can compete for the same
 *               capacity, e.g. for a hot-path fallback when one half is dry)
 *
 * Splitting halves the chance that a noisy conversational burst starves an
 * unrelated background tool of capacity (and vice versa) when keys are few.
 *
 * @param {string} name
 * @param {string[]} keys
 * @param {new (opts: { apiKey: string }) => any} ClientClass
 * @param {{ log?: (m: string) => void }} [opts]
 */
export function createSplitPools(name, keys, ClientClass, opts = {}) {
  if (!keys?.length) return { conv: null, work: null, all: null };
  const log = opts.log || _noop;

  const convKeys = keys.filter((_, i) => i % 2 === 0);
  const workKeys = keys.length > 1 ? keys.filter((_, i) => i % 2 === 1) : [...keys];

  const conv = new KeyPool(`${name}-conv`, convKeys, ClientClass, { log });
  const work = new KeyPool(`${name}-work`, workKeys, ClientClass, { log });
  const all = new KeyPool(`${name}-all`, keys, ClientClass, { log });

  log(`[KeyPool:${name}] Split ${keys.length} keys → ${convKeys.length} conversation + ${workKeys.length} worker`);

  return { conv, work, all };
}
