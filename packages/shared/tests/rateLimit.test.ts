import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module without .d.ts; types not needed here.
import { createRateLimiter } from "../src/rateLimit.js";

describe("createRateLimiter", () => {
  it("allows up to `limit` hits per key inside the window, then 429s", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const now = 1_000_000;
    expect(rl.allow("a", now)).toBe(true);
    expect(rl.allow("a", now + 1)).toBe(true);
    expect(rl.allow("a", now + 2)).toBe(true);
    expect(rl.allow("a", now + 3)).toBe(false);
    expect(rl.allow("a", now + 4)).toBe(false);
  });

  it("isolates per key — a flooder on key A doesn't block key B", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const now = 1_000_000;
    expect(rl.allow("a", now)).toBe(true);
    expect(rl.allow("a", now)).toBe(true);
    expect(rl.allow("a", now)).toBe(false);
    // B should be untouched.
    expect(rl.allow("b", now)).toBe(true);
    expect(rl.allow("b", now)).toBe(true);
    expect(rl.allow("b", now)).toBe(false);
  });

  it("recovers as old hits age out (sliding window)", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect(rl.allow("a", t0)).toBe(true);
    expect(rl.allow("a", t0 + 1_000)).toBe(true);
    expect(rl.allow("a", t0 + 2_000)).toBe(false);
    // Once the first hit falls outside the window the caller gets a fresh slot.
    expect(rl.allow("a", t0 + 60_001)).toBe(true);
  });

  it("evicts the stalest key when the maxKeys soft cap fills up", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    rl.allow("oldest", 1_000);
    rl.allow("middle", 2_000);
    rl.allow("newest", 3_000);
    expect(rl._size()).toBe(3);
    // Adding a fourth key should evict the stalest (oldest most-recent hit).
    rl.allow("fourth", 4_000);
    expect(rl._size()).toBe(3);
    // "oldest" should now be re-allowed because its history was dropped.
    expect(rl.allow("oldest", 5_000)).toBe(true);
  });

  it("treats empty / non-string keys as unkeyed (always-allow)", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.allow("", 1)).toBe(true);
    expect(rl.allow("", 2)).toBe(true);
    // @ts-expect-error — runtime guard against non-strings
    expect(rl.allow(null, 3)).toBe(true);
  });

  it("rejects bad constructor args (fail-loud on misconfiguration)", () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 60_000 })).toThrow();
    expect(() => createRateLimiter({ limit: 5, windowMs: 0 })).toThrow();
    expect(() => createRateLimiter({})).toThrow();
  });

  it("reset() drops all in-flight state", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.allow("a", 100)).toBe(true);
    expect(rl.allow("a", 101)).toBe(false);
    rl.reset();
    expect(rl.allow("a", 102)).toBe(true);
  });
});
