// Council-round regression seeds for ai/poker.js
// Priorities:
//   - Split-pot leftover distribution (the bug we fixed: Math.floor was
//     leaking residual coins to the house on ties).
//   - Hand evaluator correctness — council auditor originally flagged the
//     compareHands sign as "inverted, always picks worst hand," which was
//     a misread. This pins the actual convention so future audits don't
//     get confused again.

import { describe, it, expect } from "vitest";
import {
  evalFiveCards,
  compareHands,
  bestFiveOfSeven,
  splitPot,
} from "../../ai/poker.js";

// ─── splitPot — the bug we actually fixed ──────────────────────────────────

describe("splitPot — leftover distribution (council round C-era bug)", () => {
  it("solo winner receives the full after-rake pot", () => {
    const { rake, payouts } = splitPot(100, 0.05, 1);
    expect(rake).toBe(5);
    expect(payouts).toEqual([95]);
  });

  it("two winners on a 100-coin pot split 95 evenly with nobody losing a coin", () => {
    const { rake, payouts } = splitPot(100, 0.05, 2);
    expect(rake).toBe(5);
    // 95 / 2 = 47, leftover 1 → first winner gets +1
    expect(payouts).toEqual([48, 47]);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(95);
  });

  it("three winners on a 100-coin pot — 2 leftover coins go to first two winners", () => {
    // This is the exact scenario that originally leaked 2 coins to the house:
    //   floor(95 / 3) = 31 each × 3 = 93, 2 coins unaccounted for.
    const { rake, payouts } = splitPot(100, 0.05, 3);
    expect(rake).toBe(5);
    expect(payouts).toEqual([32, 32, 31]);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(95);
  });

  it("four winners on a 100-coin pot — 3 leftover coins go to first three winners", () => {
    const { rake, payouts } = splitPot(100, 0.05, 4);
    expect(rake).toBe(5);
    // 95 / 4 = 23, leftover 3 → first three winners get +1 each
    expect(payouts).toEqual([24, 24, 24, 23]);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(95);
  });

  it("five winners on a 100-coin pot — exact divide, no leftover", () => {
    const { rake, payouts } = splitPot(100, 0.05, 5);
    expect(rake).toBe(5);
    // 95 / 5 = 19, exact
    expect(payouts).toEqual([19, 19, 19, 19, 19]);
  });

  it("zero winners returns empty payouts (no crash)", () => {
    const { rake, payouts } = splitPot(100, 0.05, 0);
    expect(rake).toBe(5);
    expect(payouts).toEqual([]);
  });

  it("zero pot returns zero rake and no payouts", () => {
    const { rake, payouts } = splitPot(0, 0.05, 3);
    expect(rake).toBe(0);
    expect(payouts).toEqual([0, 0, 0]);
  });

  it("rounds rake down (integer coin discipline)", () => {
    const { rake } = splitPot(199, 0.05, 1);
    // 199 * 0.05 = 9.95 → floor to 9
    expect(rake).toBe(9);
  });

  it("handles non-integer pot input by flooring", () => {
    const { rake, payouts } = splitPot(100.9, 0.05, 2);
    expect(rake).toBe(5);
    // pot = floor(100.9) = 100, pool = 95, 95 / 2 = 47, leftover 1
    expect(payouts).toEqual([48, 47]);
  });

  it("handles negative / bogus pot by coercing to zero", () => {
    expect(splitPot(-50, 0.05, 3).payouts).toEqual([0, 0, 0]);
    expect(splitPot(NaN as any, 0.05, 3).payouts).toEqual([0, 0, 0]);
  });

  it("INVARIANT: rake + sum(payouts) always equals pot exactly — no coin vanishes", () => {
    // The bug was coins vanishing. This is the invariant that proves the fix.
    for (const pot of [1, 10, 99, 100, 101, 500, 1234, 9999]) {
      for (const winners of [1, 2, 3, 4, 5, 7, 11]) {
        const { rake, payouts } = splitPot(pot, 0.05, winners);
        const sum = payouts.reduce((a, b) => a + b, 0);
        expect(rake + sum).toBe(pot);
      }
    }
  });
});

// ─── Hand evaluation (evalFiveCards) ───────────────────────────────────────

// card helpers — suits are just labels, values are numeric 2..14 (14 = Ace)
const C = (value: number, suit: string) => ({ value, suit });

describe("evalFiveCards", () => {
  it("identifies a royal-straight-flush as category 9 (highest)", () => {
    const h = evalFiveCards([C(10, "♠"), C(11, "♠"), C(12, "♠"), C(13, "♠"), C(14, "♠")]);
    expect(h.category).toBe(9);
    expect(h.ranks[0]).toBe(14); // high card
  });

  it("identifies a wheel straight (A-2-3-4-5) with straight-high = 5, NOT 14", () => {
    const h = evalFiveCards([C(14, "♠"), C(2, "♥"), C(3, "♦"), C(4, "♣"), C(5, "♠")]);
    expect(h.category).toBe(5); // straight
    expect(h.ranks[0]).toBe(5); // ace-low straight tops at 5
  });

  it("identifies four of a kind with the kicker preserved in ranks", () => {
    const h = evalFiveCards([C(10, "♠"), C(10, "♥"), C(10, "♦"), C(10, "♣"), C(3, "♠")]);
    expect(h.category).toBe(8);
    expect(h.ranks).toEqual([10, 3]);
  });

  it("identifies a full house (three-plus-two, higher card first)", () => {
    const h = evalFiveCards([C(7, "♠"), C(7, "♥"), C(7, "♦"), C(2, "♣"), C(2, "♠")]);
    expect(h.category).toBe(7);
    expect(h.ranks).toEqual([7, 2]); // trips rank then pair rank
  });

  it("identifies a flush — ranks are all five cards sorted descending", () => {
    const h = evalFiveCards([C(14, "♠"), C(10, "♠"), C(7, "♠"), C(4, "♠"), C(2, "♠")]);
    expect(h.category).toBe(6);
    expect(h.ranks).toEqual([14, 10, 7, 4, 2]);
  });

  it("identifies a regular straight (not wheel, not flush)", () => {
    const h = evalFiveCards([C(6, "♠"), C(7, "♥"), C(8, "♦"), C(9, "♣"), C(10, "♠")]);
    expect(h.category).toBe(5);
    expect(h.ranks[0]).toBe(10);
  });

  it("identifies two pair with the higher pair first", () => {
    const h = evalFiveCards([C(10, "♠"), C(10, "♥"), C(3, "♦"), C(3, "♣"), C(14, "♠")]);
    expect(h.category).toBe(3);
    expect(h.ranks).toEqual([10, 3, 14]); // high pair, low pair, kicker
  });

  it("identifies high card with all five values sorted descending", () => {
    const h = evalFiveCards([C(14, "♠"), C(12, "♥"), C(10, "♦"), C(7, "♣"), C(3, "♠")]);
    expect(h.category).toBe(1);
    expect(h.ranks).toEqual([14, 12, 10, 7, 3]);
  });
});

// ─── compareHands — the sign convention that confused the auditor ─────────

describe("compareHands (convention pin)", () => {
  // Convention (pinned here to stop future confusion):
  //   compareHands(a, b) < 0  ⇔  a is BETTER than b
  //   compareHands(a, b) > 0  ⇔  a is WORSE than b
  //   compareHands(a, b) === 0 ⇔ tie

  it("returns a negative number when a beats b", () => {
    const royal = evalFiveCards([C(10, "♠"), C(11, "♠"), C(12, "♠"), C(13, "♠"), C(14, "♠")]);
    const high  = evalFiveCards([C(14, "♠"), C(12, "♥"), C(10, "♦"), C(7, "♣"), C(3, "♠")]);
    expect(compareHands(royal, high)).toBeLessThan(0);
  });

  it("returns a positive number when a loses to b", () => {
    const royal = evalFiveCards([C(10, "♠"), C(11, "♠"), C(12, "♠"), C(13, "♠"), C(14, "♠")]);
    const high  = evalFiveCards([C(14, "♠"), C(12, "♥"), C(10, "♦"), C(7, "♣"), C(3, "♠")]);
    expect(compareHands(high, royal)).toBeGreaterThan(0);
  });

  it("returns zero for identical hands (true tie)", () => {
    const a = evalFiveCards([C(10, "♠"), C(10, "♥"), C(3, "♦"), C(3, "♣"), C(14, "♠")]);
    const b = evalFiveCards([C(10, "♦"), C(10, "♣"), C(3, "♠"), C(3, "♥"), C(14, "♦")]);
    expect(compareHands(a, b)).toBe(0);
  });

  it("tiebreaks by kicker when ranks at same category match most positions", () => {
    // Both pair of 10s, different kicker
    const with14 = evalFiveCards([C(10, "♠"), C(10, "♥"), C(14, "♦"), C(3, "♣"), C(2, "♠")]);
    const with13 = evalFiveCards([C(10, "♦"), C(10, "♣"), C(13, "♠"), C(3, "♥"), C(2, "♦")]);
    expect(compareHands(with14, with13)).toBeLessThan(0); // 14-kicker beats 13-kicker
  });
});

// ─── bestFiveOfSeven — the evaluator used on hole+community ─────────────────

describe("bestFiveOfSeven", () => {
  it("picks the best possible 5-card hand from 7", () => {
    // Two hole + five community → the five community ARE a royal flush,
    // so bestOfSeven should return exactly that royal flush.
    const seven = [
      C(2, "♥"), C(5, "♦"),                                    // hole
      C(10, "♠"), C(11, "♠"), C(12, "♠"), C(13, "♠"), C(14, "♠"), // community = royal
    ];
    const best = bestFiveOfSeven(seven);
    expect(best.evaluation.category).toBe(9);
    expect(best.cards).toHaveLength(5);
    expect(best.cards.every((c: any) => c.suit === "♠")).toBe(true);
  });

  it("prefers a straight over a pair when both are available in 7 cards", () => {
    const seven = [
      C(5, "♥"), C(5, "♦"),                                // hole pair
      C(6, "♣"), C(7, "♠"), C(8, "♥"), C(9, "♦"), C(2, "♣"), // community — straight 5..9
    ];
    const best = bestFiveOfSeven(seven);
    expect(best.evaluation.category).toBe(5); // straight
    expect(best.evaluation.ranks[0]).toBe(9);
  });
});
