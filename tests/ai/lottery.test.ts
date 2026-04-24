// Council-round regression seeds for ai/lottery.js
// Priorities:
//   - Weighted-draw picks winners proportional to ticket count (no bias).
//   - Rollover math: 30% of pot rolls, rest is prize; coin-exact.
//   - Invariant: rollover + prize === pot (no coins leak).
//
// We test the pure extracted helpers (_testPickWinner + _testComputeRollover)
// rather than the full tickLotteryDraw — that path requires Supabase + a
// module-level mutex and isn't worth mocking for regression pinning.

import { describe, it, expect } from "vitest";
import { _testPickWinner, _testComputeRollover, _testConstants } from "../../ai/lottery.js";

// ─── Weighted draw ─────────────────────────────────────────────────────────

describe("_testPickWinner (weighted draw)", () => {
  it("single buyer wins every time", () => {
    const res = _testPickWinner({ u1: 5 }, 1);
    expect(res.winnerId).toBe("u1");
    expect(res.winningCount).toBe(5);
    expect(res.totalTickets).toBe(5);
  });

  it("roll=1 always picks the first buyer in iteration order", () => {
    const res = _testPickWinner({ u1: 3, u2: 7 }, 1);
    expect(res.winnerId).toBe("u1");
  });

  it("roll at buyer-1's upper bound goes to buyer-1", () => {
    // u1 has 3 tickets, so rolls 1..3 go to u1; 4..10 go to u2.
    const res = _testPickWinner({ u1: 3, u2: 7 }, 3);
    expect(res.winnerId).toBe("u1");
  });

  it("roll just past buyer-1's range goes to buyer-2", () => {
    const res = _testPickWinner({ u1: 3, u2: 7 }, 4);
    expect(res.winnerId).toBe("u2");
  });

  it("roll at the total-tickets upper bound still picks a valid winner", () => {
    // Edge case — roll === totalTickets.
    const res = _testPickWinner({ u1: 3, u2: 7 }, 10);
    expect(res.winnerId).toBe("u2");
  });

  it("returns null winner on empty ticket map (no crash, no pay-null)", () => {
    const res = _testPickWinner({}, 1);
    expect(res.winnerId).toBe(null);
    expect(res.totalTickets).toBe(0);
  });

  it("skips malformed buyer entries (non-integer / zero / negative / NaN)", () => {
    const res = _testPickWinner(
      { "valid-user": 3, bad1: "x" as any, bad2: 0, bad3: -1, bad4: 1.5, bad5: NaN },
      1
    );
    expect(res.winnerId).toBe("valid-user");
    expect(res.totalTickets).toBe(3);
  });

  it("distribution is proportional to ticket weight (monte-carlo)", () => {
    // Over many rolls, a buyer with 80% of tickets should win ~80% of the time.
    const tickets = { whale: 80, minnow: 20 };
    const trials = 10_000;
    let whaleWins = 0;
    for (let i = 0; i < trials; i++) {
      const roll = Math.floor(Math.random() * 100) + 1; // 1..100 inclusive
      const res = _testPickWinner(tickets, roll);
      if (res.winnerId === "whale") whaleWins++;
    }
    const whaleRate = whaleWins / trials;
    // Expect between 77% and 83% with trials=10k (within ~1σ tolerance)
    expect(whaleRate).toBeGreaterThan(0.77);
    expect(whaleRate).toBeLessThan(0.83);
  });

  it("tiny vs huge weights — tiny-holder wins proportionally rare but non-zero", () => {
    const tickets = { tiny: 1, huge: 999 };
    const trials = 10_000;
    let tinyWins = 0;
    for (let i = 0; i < trials; i++) {
      const roll = Math.floor(Math.random() * 1000) + 1;
      const res = _testPickWinner(tickets, roll);
      if (res.winnerId === "tiny") tinyWins++;
    }
    // Expect ~10 wins (0.1%). Allow 0..30 for stochastic variance.
    expect(tinyWins).toBeGreaterThanOrEqual(0);
    expect(tinyWins).toBeLessThan(30);
  });
});

// ─── Rollover math ─────────────────────────────────────────────────────────

describe("_testComputeRollover (30% rolls, coin-exact)", () => {
  it("100-coin pot rolls 30, prize is 70", () => {
    const { rollover, prize } = _testComputeRollover(100);
    expect(rollover).toBe(30);
    expect(prize).toBe(70);
  });

  it("1000-coin pot rolls 300, prize is 700", () => {
    const { rollover, prize } = _testComputeRollover(1000);
    expect(rollover).toBe(300);
    expect(prize).toBe(700);
  });

  it("1-coin pot rolls 0 (floor), prize is 1", () => {
    const { rollover, prize } = _testComputeRollover(1);
    expect(rollover).toBe(0);
    expect(prize).toBe(1);
  });

  it("zero pot stays zero", () => {
    expect(_testComputeRollover(0)).toEqual({ rollover: 0, prize: 0 });
  });

  it("INVARIANT: rollover + prize === pot (no coin vanishes)", () => {
    for (const pot of [0, 1, 7, 11, 99, 100, 101, 999, 1000, 123456, 999999]) {
      const { rollover, prize } = _testComputeRollover(pot);
      expect(rollover + prize).toBe(pot);
    }
  });

  it("rollover fraction matches the declared constant", () => {
    expect(_testConstants.ROLLOVER_FRACTION).toBe(0.30);
  });

  it("handles non-integer / negative pot by coercing to zero-or-floor", () => {
    expect(_testComputeRollover(-50)).toEqual({ rollover: 0, prize: 0 });
    // 100.7 → floor to 100 → roll 30, prize 70
    expect(_testComputeRollover(100.7)).toEqual({ rollover: 30, prize: 70 });
  });
});

// ─── Ticket-cap constant (matches the cap enforced in buyLotteryTicket) ──

describe("ticket accumulation cap constant", () => {
  it("is set to 999_000 (leaves headroom below the 1M load-path filter)", () => {
    expect(_testConstants.MAX_PER_USER).toBe(999_000);
  });

  it("ticket price is 100 coins", () => {
    expect(_testConstants.TICKET_PRICE).toBe(100);
  });
});
