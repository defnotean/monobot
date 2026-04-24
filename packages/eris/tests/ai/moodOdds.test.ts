import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { getMoodAdjustedOdds, MOOD_MAX_ODDS_SHIFT } from "../../ai/gambling.js";

describe("getMoodAdjustedOdds", () => {
  it("is the base probability at mood 0", () => {
    expect(getMoodAdjustedOdds(0.5, 0)).toBeCloseTo(0.5, 6);
  });

  it("never shifts by more than MOOD_MAX_ODDS_SHIFT", () => {
    const base = 0.5;
    for (let mood = -100; mood <= 100; mood += 5) {
      const adjusted = getMoodAdjustedOdds(base, mood);
      expect(Math.abs(adjusted - base)).toBeLessThanOrEqual(MOOD_MAX_ODDS_SHIFT + 1e-9);
    }
  });

  it("hits exactly +MOOD_MAX_ODDS_SHIFT at mood +100", () => {
    expect(getMoodAdjustedOdds(0.5, 100)).toBeCloseTo(0.5 + MOOD_MAX_ODDS_SHIFT, 6);
  });

  it("hits exactly -MOOD_MAX_ODDS_SHIFT at mood -100", () => {
    expect(getMoodAdjustedOdds(0.5, -100)).toBeCloseTo(0.5 - MOOD_MAX_ODDS_SHIFT, 6);
  });

  it("clamps mood scores outside [-100, 100] rather than exploding", () => {
    // Someone corrupts the Supabase row and mood_score comes back 1e9 — the
    // old implementation would shift odds off the charts. We clamp defensively.
    expect(getMoodAdjustedOdds(0.5, 1e9)).toBeCloseTo(0.5 + MOOD_MAX_ODDS_SHIFT, 6);
    expect(getMoodAdjustedOdds(0.5, -1e9)).toBeCloseTo(0.5 - MOOD_MAX_ODDS_SHIFT, 6);
  });

  it("treats NaN/undefined mood as neutral instead of throwing", () => {
    expect(getMoodAdjustedOdds(0.5, NaN)).toBeCloseTo(0.5, 6);
    // @ts-expect-error - deliberately passing undefined
    expect(getMoodAdjustedOdds(0.5, undefined)).toBeCloseTo(0.5, 6);
  });

  it("never returns a probability outside [0.05, 0.95]", () => {
    expect(getMoodAdjustedOdds(0.01, -100)).toBeGreaterThanOrEqual(0.05);
    expect(getMoodAdjustedOdds(0.99, 100)).toBeLessThanOrEqual(0.95);
  });

  it("is monotonic in mood score — better mood never reduces odds", () => {
    let prev = getMoodAdjustedOdds(0.5, -100);
    for (let mood = -95; mood <= 100; mood += 5) {
      const cur = getMoodAdjustedOdds(0.5, mood);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });
});
