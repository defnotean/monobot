// Council-round regression seeds for ai/stockMarket.js
// Priorities:
//   - GBM price step stays bounded (±20% clamp + PRICE_FLOOR..PRICE_CEIL).
//   - Share-count parser rejects the classes of input that would otherwise
//     overflow Number.MAX_SAFE_INTEGER when multiplied by a high price
//     (the hardening that accompanied the moonshot).
//
// The full buy/sell path depends on Supabase + withUserLock and isn't worth
// mocking up for these tests; the council flagged "tests that would have
// caught the bugs we shipped" — those bugs were in the pure slices below.

import { describe, it, expect } from "vitest";
import {
  _testStepPrice,
  _testParseShareCount,
  _testBounds,
} from "../../ai/stockMarket.js";

// ─── Share-count parser ─────────────────────────────────────────────────────

describe("_parseShareCount (rejects bad inputs, clamps overflow)", () => {
  it("accepts a positive integer", () => {
    expect(_testParseShareCount(1)).toBe(1);
    expect(_testParseShareCount(100)).toBe(100);
  });

  it("floors positive non-integers", () => {
    expect(_testParseShareCount(3.9)).toBe(3);
    expect(_testParseShareCount(1.0001)).toBe(1);
  });

  it("returns null for zero / negatives (invalid for a buy)", () => {
    expect(_testParseShareCount(0)).toBe(null);
    expect(_testParseShareCount(-1)).toBe(null);
    expect(_testParseShareCount(-0.5)).toBe(null);
  });

  it("returns null for NaN / Infinity / non-numeric", () => {
    expect(_testParseShareCount(NaN)).toBe(null);
    expect(_testParseShareCount(Infinity)).toBe(null);
    expect(_testParseShareCount(-Infinity)).toBe(null);
    expect(_testParseShareCount("xyz")).toBe(null);
    expect(_testParseShareCount(undefined)).toBe(null);
    expect(_testParseShareCount(null)).toBe(null);
  });

  it("clamps huge counts to MAX_SHARES_PER_CALL (no MAX_SAFE_INTEGER overflow)", () => {
    const max = _testBounds.MAX_SHARES_PER_CALL;
    expect(_testParseShareCount(max)).toBe(max);
    expect(_testParseShareCount(max + 1)).toBe(max);
    // The scenario the hardening was designed against: AI hallucinates
    // "buy 999999999 shares" → without the clamp, this × $1,000,000
    // price_ceil silently overflows to lose precision.
    expect(_testParseShareCount(999_999_999)).toBe(max);
    expect(_testParseShareCount(Number.MAX_SAFE_INTEGER)).toBe(max);
  });

  it("accepts numeric strings (Discord slash option coerces to string sometimes)", () => {
    expect(_testParseShareCount("5")).toBe(5);
    expect(_testParseShareCount("  10  ")).toBe(10);
  });
});

// ─── GBM price step bounds ──────────────────────────────────────────────────

describe("_stepPrice (GBM step stays bounded)", () => {
  function mkTicker(overrides: Partial<{ price: number; basePrice: number; volatility: number }> = {}) {
    return {
      price: 100,
      basePrice: 100,
      volatility: 0.05,
      history: [100] as number[],
      ...overrides,
    };
  }

  it("price never goes below PRICE_FLOOR after a step", () => {
    // Simulate 500 steps with a pathologically high volatility — despite the
    // shock, the ±20% clamp + floor prevents it from dropping below PRICE_FLOOR.
    const t = mkTicker({ price: 10, volatility: 0.5 });
    for (let i = 0; i < 500; i++) _testStepPrice(t);
    expect(t.price).toBeGreaterThanOrEqual(_testBounds.PRICE_FLOOR);
  });

  it("price never exceeds PRICE_CEIL after a step", () => {
    const t = mkTicker({ price: 500_000, volatility: 0.5 });
    for (let i = 0; i < 500; i++) _testStepPrice(t);
    expect(t.price).toBeLessThanOrEqual(_testBounds.PRICE_CEIL);
  });

  it("single step moves price by at most MAX_PCT_PER_TICK (±20%)", () => {
    // The clamp guarantees |Δ%| ≤ MAX_PCT_PER_TICK on any single tick,
    // even with extreme volatility. This is the invariant the moonshot
    // depends on (no 10x overnight swings).
    const bound = _testBounds.MAX_PCT_PER_TICK;
    for (let i = 0; i < 200; i++) {
      const t = mkTicker({ price: 100, volatility: 0.5 });
      const before = t.price;
      _testStepPrice(t);
      const pct = Math.abs(t.price - before) / before;
      // Allow a tiny rounding tolerance — _stepPrice rounds to 2 decimal places
      expect(pct).toBeLessThanOrEqual(bound + 0.001);
    }
  });

  it("pushes the new price into history", () => {
    const t = mkTicker();
    _testStepPrice(t);
    expect(t.history.length).toBe(2);
    expect(t.history[1]).toBe(t.price);
  });

  it("price rounds to 2 decimal places (no floating-point sliver accumulation)", () => {
    const t = mkTicker();
    _testStepPrice(t);
    const rounded = Math.round(t.price * 100) / 100;
    expect(t.price).toBe(rounded);
  });

  it("mean-reversion drags price toward basePrice over many steps", () => {
    // Start price far from basePrice; over N steps, average price should
    // converge closer to basePrice than the starting point.
    const N = 200;
    const trials = 30;
    let avg = 0;
    for (let tr = 0; tr < trials; tr++) {
      const t = mkTicker({ price: 300, basePrice: 100, volatility: 0.02 });
      for (let i = 0; i < N; i++) _testStepPrice(t);
      avg += t.price;
    }
    avg /= trials;
    // Not asserting convergence to 100 (stochastic, N finite), just that
    // the average final price is closer to the basePrice than to the start.
    expect(Math.abs(avg - 100)).toBeLessThan(Math.abs(300 - 100));
  });
});
