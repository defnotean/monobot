import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import {
  spin,
  colorOf,
  validateBet,
  resolveBet,
  describeBet,
  RED_NUMBERS,
  BLACK_NUMBERS,
  BET_TYPES,
} from "../../../ai/gambling/roulette.js";

describe("roulette.spin", () => {
  it("returns 0–36 inclusive", () => {
    for (let i = 0; i < 1000; i++) {
      const n = spin();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(36);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("uses injected rng", () => {
    expect(spin(() => 0)).toBe(0);
    expect(spin(() => 0.999)).toBe(36);
    expect(spin(() => 0.5)).toBe(18);
  });
});

describe("roulette.colorOf", () => {
  it("0 is green", () => {
    expect(colorOf(0)).toBe("green");
  });

  it("classifies all 18 reds correctly", () => {
    expect(RED_NUMBERS.size).toBe(18);
    for (const n of RED_NUMBERS) expect(colorOf(n)).toBe("red");
  });

  it("classifies all 18 blacks correctly", () => {
    expect(BLACK_NUMBERS.size).toBe(18);
    for (const n of BLACK_NUMBERS) expect(colorOf(n)).toBe("black");
  });

  it("reds and blacks are disjoint", () => {
    for (const n of RED_NUMBERS) expect(BLACK_NUMBERS.has(n)).toBe(false);
  });

  it("reds + blacks + green = 37 numbers (0-36)", () => {
    expect(RED_NUMBERS.size + BLACK_NUMBERS.size + 1).toBe(37);
  });

  it("throws on invalid input", () => {
    expect(() => colorOf(37)).toThrow();
    expect(() => colorOf(-1)).toThrow();
  });
});

describe("roulette.validateBet", () => {
  it("accepts every BET_TYPE with positive integer amount", () => {
    for (const type of BET_TYPES) {
      const bet = type === "straight" ? { type, amount: 10, number: 5 } : { type, amount: 10 };
      expect(validateBet(bet)).toEqual({ ok: true });
    }
  });

  it("rejects unknown type", () => {
    expect(validateBet({ type: "weird", amount: 10 }).ok).toBe(false);
    expect(validateBet({ type: undefined, amount: 10 }).ok).toBe(false);
  });

  it("rejects non-integer amount", () => {
    expect(validateBet({ type: "red", amount: 10.5 }).ok).toBe(false);
    expect(validateBet({ type: "red", amount: NaN }).ok).toBe(false);
    expect(validateBet({ type: "red", amount: Infinity }).ok).toBe(false);
    expect(validateBet({ type: "red", amount: -5 }).ok).toBe(false);
    expect(validateBet({ type: "red", amount: 0 }).ok).toBe(false);
  });

  it("requires number 0–36 for straight", () => {
    expect(validateBet({ type: "straight", amount: 10 }).ok).toBe(false);
    expect(validateBet({ type: "straight", amount: 10, number: 37 }).ok).toBe(false);
    expect(validateBet({ type: "straight", amount: 10, number: -1 }).ok).toBe(false);
    expect(validateBet({ type: "straight", amount: 10, number: 1.5 }).ok).toBe(false);
    expect(validateBet({ type: "straight", amount: 10, number: 0 }).ok).toBe(true);
    expect(validateBet({ type: "straight", amount: 10, number: 36 }).ok).toBe(true);
  });

  it("ignores number on outside bets", () => {
    expect(validateBet({ type: "red", amount: 10, number: 999 }).ok).toBe(true);
  });
});

describe("roulette.resolveBet — outside bets", () => {
  it("0 loses every outside bet", () => {
    for (const type of ["red", "black", "even", "odd", "low", "high", "dozen_1", "dozen_2", "dozen_3", "column_1", "column_2", "column_3"]) {
      const r = resolveBet({ type, amount: 10 }, 0);
      expect(r.won).toBe(false);
      expect(r.payout).toBe(0);
    }
  });

  it("red wins on red numbers, loses on black", () => {
    expect(resolveBet({ type: "red", amount: 10 }, 1).won).toBe(true);
    expect(resolveBet({ type: "red", amount: 10 }, 2).won).toBe(false);
    expect(resolveBet({ type: "red", amount: 10 }, 1).payout).toBe(20); // stake + 1x
  });

  it("black wins on black numbers, loses on red", () => {
    expect(resolveBet({ type: "black", amount: 10 }, 2).won).toBe(true);
    expect(resolveBet({ type: "black", amount: 10 }, 1).won).toBe(false);
  });

  it("even/odd parity", () => {
    expect(resolveBet({ type: "even", amount: 5 }, 2).won).toBe(true);
    expect(resolveBet({ type: "even", amount: 5 }, 3).won).toBe(false);
    expect(resolveBet({ type: "odd", amount: 5 }, 3).won).toBe(true);
    expect(resolveBet({ type: "odd", amount: 5 }, 2).won).toBe(false);
  });

  it("low (1-18) and high (19-36)", () => {
    expect(resolveBet({ type: "low", amount: 10 }, 1).won).toBe(true);
    expect(resolveBet({ type: "low", amount: 10 }, 18).won).toBe(true);
    expect(resolveBet({ type: "low", amount: 10 }, 19).won).toBe(false);
    expect(resolveBet({ type: "high", amount: 10 }, 19).won).toBe(true);
    expect(resolveBet({ type: "high", amount: 10 }, 36).won).toBe(true);
    expect(resolveBet({ type: "high", amount: 10 }, 18).won).toBe(false);
  });

  it("dozens", () => {
    expect(resolveBet({ type: "dozen_1", amount: 10 }, 1).won).toBe(true);
    expect(resolveBet({ type: "dozen_1", amount: 10 }, 12).won).toBe(true);
    expect(resolveBet({ type: "dozen_1", amount: 10 }, 13).won).toBe(false);
    expect(resolveBet({ type: "dozen_2", amount: 10 }, 13).won).toBe(true);
    expect(resolveBet({ type: "dozen_2", amount: 10 }, 24).won).toBe(true);
    expect(resolveBet({ type: "dozen_2", amount: 10 }, 25).won).toBe(false);
    expect(resolveBet({ type: "dozen_3", amount: 10 }, 25).won).toBe(true);
    expect(resolveBet({ type: "dozen_3", amount: 10 }, 36).won).toBe(true);
    expect(resolveBet({ type: "dozen_3", amount: 10 }, 24).won).toBe(false);
  });

  it("dozen pays 2:1 (stake + 2x)", () => {
    expect(resolveBet({ type: "dozen_1", amount: 10 }, 5).payout).toBe(30);
  });

  it("columns", () => {
    // Column 1: 1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34
    expect(resolveBet({ type: "column_1", amount: 10 }, 1).won).toBe(true);
    expect(resolveBet({ type: "column_1", amount: 10 }, 4).won).toBe(true);
    expect(resolveBet({ type: "column_1", amount: 10 }, 34).won).toBe(true);
    expect(resolveBet({ type: "column_1", amount: 10 }, 2).won).toBe(false);
    // Column 2: 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35
    expect(resolveBet({ type: "column_2", amount: 10 }, 2).won).toBe(true);
    expect(resolveBet({ type: "column_2", amount: 10 }, 35).won).toBe(true);
    expect(resolveBet({ type: "column_2", amount: 10 }, 1).won).toBe(false);
    // Column 3: 3, 6, 9, 12, ..., 36
    expect(resolveBet({ type: "column_3", amount: 10 }, 3).won).toBe(true);
    expect(resolveBet({ type: "column_3", amount: 10 }, 36).won).toBe(true);
    expect(resolveBet({ type: "column_3", amount: 10 }, 1).won).toBe(false);
  });
});

describe("roulette.resolveBet — straight bet", () => {
  it("hits exactly on the chosen number", () => {
    expect(resolveBet({ type: "straight", amount: 10, number: 17 }, 17).won).toBe(true);
    expect(resolveBet({ type: "straight", amount: 10, number: 17 }, 18).won).toBe(false);
  });

  it("can hit on 0", () => {
    expect(resolveBet({ type: "straight", amount: 10, number: 0 }, 0).won).toBe(true);
  });

  it("pays 35:1 (stake + 35x)", () => {
    expect(resolveBet({ type: "straight", amount: 10, number: 7 }, 7).payout).toBe(360);
  });

  it("loses if number doesn't match", () => {
    expect(resolveBet({ type: "straight", amount: 10, number: 5 }, 6).payout).toBe(0);
  });
});

describe("roulette.resolveBet — invalid inputs", () => {
  it("throws on invalid bet shape", () => {
    expect(() => resolveBet({ type: "weird", amount: 10 }, 5)).toThrow();
    expect(() => resolveBet({ type: "red", amount: -5 }, 5)).toThrow();
  });

  it("throws on invalid spunNumber", () => {
    expect(() => resolveBet({ type: "red", amount: 10 }, 37)).toThrow();
    expect(() => resolveBet({ type: "red", amount: 10 }, -1)).toThrow();
    expect(() => resolveBet({ type: "red", amount: 10 }, 1.5)).toThrow();
  });
});

describe("roulette.describeBet", () => {
  it("produces a human-readable label per type", () => {
    expect(describeBet({ type: "straight", number: 17 })).toContain("17");
    expect(describeBet({ type: "red" })).toBe("Red");
    expect(describeBet({ type: "dozen_2" })).toContain("13-24");
    expect(describeBet({ type: "column_1" })).toContain("Column 1");
  });
});

describe("roulette house edge sanity check", () => {
  it("over 100k spins, even-money bet returns ~97.3% (one in 37 is green-loss)", () => {
    let bankroll = 0;
    const spins = 100_000;
    let stake = 0;
    let rng = (() => {
      let i = 0;
      // Use a seeded LCG for determinism — same as Math.random would but reproducible
      let state = 0x12345678;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
    })();

    for (let i = 0; i < spins; i++) {
      const n = spin(rng);
      stake += 10;
      const r = resolveBet({ type: "red", amount: 10 }, n);
      bankroll += r.payout;
    }
    // Expected return ≈ stake * (18/37) * 2 = stake * 36/37 ≈ 97.297%
    const ratio = bankroll / stake;
    expect(ratio).toBeGreaterThan(0.94); // wider band — pseudo-random can drift
    expect(ratio).toBeLessThan(1.0);     // house must keep an edge over 100k spins
  });
});
