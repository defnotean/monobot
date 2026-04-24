// ai/keyPool.js — Smart API key pool with per-key rate limit tracking
// Each key tracks its own rate limit state. Round-robin skips limited keys.
// If ALL keys are limited, uses the one that recovers soonest.

import { log } from "../utils/logger.js";

class KeyPool {
  constructor(name, keys, ClientClass) {
    this.name = name;
    this.clients = keys.map((key, i) => ({
      id: i,
      client: new ClientClass({ apiKey: key }),
      rateLimitedUntil: 0,  // timestamp when this key becomes available again
      requestCount: 0,       // total requests served
      errorCount: 0,         // consecutive errors
      lastUsed: 0,
    }));
    this._idx = 0;
    log(`[KeyPool:${name}] Initialized with ${this.clients.length} keys`);
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
    log(`[KeyPool:${this.name}] All ${this.clients.length} keys rate-limited. Soonest recovery: ${Math.ceil(waitMs / 1000)}s (key ${soonest.id})`);
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
      log(`[KeyPool:${this.name}] Key ${entry.id} rate-limited for ${Math.ceil(durationMs / 1000)}s (${entry.errorCount} errors total)`);
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

export function createSplitPools(name, keys, ClientClass) {
  if (!keys?.length) return { conv: null, work: null, all: null };

  const convKeys = keys.filter((_, i) => i % 2 === 0);
  const workKeys = keys.length > 1 ? keys.filter((_, i) => i % 2 === 1) : [...keys];

  const conv = new KeyPool(`${name}-conv`, convKeys, ClientClass);
  const work = new KeyPool(`${name}-work`, workKeys, ClientClass);
  const all = new KeyPool(`${name}-all`, keys, ClientClass);

  log(`[KeyPool:${name}] Split ${keys.length} keys → ${convKeys.length} conversation + ${workKeys.length} worker`);

  return { conv, work, all };
}
