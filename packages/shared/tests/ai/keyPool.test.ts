import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { KeyPool, createSplitPools } from "../../src/ai/keyPool.js";

// Stub provider client — captures the apiKey it was constructed with so we
// can assert which key the pool handed out on each get().
class StubClient {
  apiKey: string;
  constructor({ apiKey }: { apiKey: string }) { this.apiKey = apiKey; }
}

describe("KeyPool — basic round-robin", () => {
  it("rotates through keys on successive get() calls", () => {
    const pool = new KeyPool("test", ["a", "b", "c"], StubClient);
    const k1 = pool.get() as unknown as StubClient;
    const k2 = pool.get() as unknown as StubClient;
    const k3 = pool.get() as unknown as StubClient;
    expect([k1.apiKey, k2.apiKey, k3.apiKey].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns null when no keys are supplied", () => {
    const pool = new KeyPool("empty", [], StubClient);
    expect(pool.get()).toBe(null);
  });

  it("size reflects the constructed key count", () => {
    const pool = new KeyPool("test", ["a", "b", "c"], StubClient);
    expect(pool.size).toBe(3);
  });
});

describe("KeyPool — rate-limit state", () => {
  it("skips rate-limited keys and uses the next available one", () => {
    const pool = new KeyPool("test", ["a", "b", "c"], StubClient);
    const first = pool.get() as unknown as StubClient;
    pool.markRateLimited(first, 60_000);
    // Next get should NOT be the rate-limited key.
    const second = pool.get() as unknown as StubClient;
    expect(second.apiKey).not.toBe(first.apiKey);
  });

  it("falls back to the soonest-recovering key when all are limited", () => {
    const pool = new KeyPool("test", ["a", "b", "c"], StubClient);
    const k1 = pool.get() as unknown as StubClient;
    const k2 = pool.get() as unknown as StubClient;
    const k3 = pool.get() as unknown as StubClient;
    pool.markRateLimited(k1, 30_000);
    pool.markRateLimited(k2, 60_000);
    pool.markRateLimited(k3, 90_000);
    // Soonest recovery is k1 — the pool should still return some client (not null).
    const fallback = pool.get();
    expect(fallback).not.toBe(null);
    expect(pool.allLimited()).toBe(true);
  });

  it("markSuccess resets the error counter", () => {
    const pool = new KeyPool("test", ["a"], StubClient);
    const c = pool.get() as unknown as StubClient;
    pool.markRateLimited(c, 1_000);
    expect(pool.stats().keys[0].errors).toBe(1);
    pool.markSuccess(c);
    expect(pool.stats().keys[0].errors).toBe(0);
  });
});

describe("KeyPool — injected logger", () => {
  it("calls the provided log function on init and on all-limited fallback", () => {
    const captured: string[] = [];
    const pool = new KeyPool("test", ["a", "b"], StubClient, { log: (m: string) => captured.push(m) });
    expect(captured.some(s => s.includes("Initialized with 2"))).toBe(true);
    const c1 = pool.get() as unknown as StubClient;
    const c2 = pool.get() as unknown as StubClient;
    pool.markRateLimited(c1, 60_000);
    pool.markRateLimited(c2, 60_000);
    pool.get(); // should log "All keys rate-limited"
    expect(captured.some(s => s.includes("rate-limited"))).toBe(true);
  });

  it("defaults to a no-op logger when none is provided (no throw)", () => {
    expect(() => new KeyPool("test", ["a"], StubClient)).not.toThrow();
  });
});

describe("createSplitPools — conv / work / all", () => {
  it("returns three null sub-pools when no keys are given", () => {
    const pools = createSplitPools("name", [], StubClient);
    expect(pools.conv).toBeNull();
    expect(pools.work).toBeNull();
    expect(pools.all).toBeNull();
  });

  it("splits keys into conv (even idx) + work (odd idx) + all", () => {
    const pools = createSplitPools("name", ["a", "b", "c", "d"], StubClient);
    expect(pools.conv.size).toBe(2);
    expect(pools.work.size).toBe(2);
    expect(pools.all.size).toBe(4);
  });

  it("uses every key for both halves when only one key is provided", () => {
    const pools = createSplitPools("name", ["only"], StubClient);
    expect(pools.conv.size).toBe(1);
    expect(pools.work.size).toBe(1);
    expect(pools.all.size).toBe(1);
  });
});
