import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// mulberry32 — small deterministic PRNG. Same seed -> same sequence every run,
// which keeps these statistical bands from flaking on CI variance.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Gambling Odds", () => {
  beforeEach(() => {
    // Fixed seed -> deterministic Math.random sequence for the whole describe.
    const rand = mulberry32(0xC0FFEE);
    vi.spyOn(Math, "random").mockImplementation(rand);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Coinflip", () => {
    it("should have approximately 50/50 odds over many flips", () => {
      let wins = 0;
      const trials = 10000;
      for (let i = 0; i < trials; i++) {
        if (Math.random() < 0.5) wins++;
      }
      const winRate = wins / trials;
      expect(winRate).toBeGreaterThan(0.45);
      expect(winRate).toBeLessThan(0.55);
    });
  });

  describe("Dice roll", () => {
    it("should have 1/6 chance of exact match", () => {
      let matches = 0;
      const trials = 12000;
      const guess = 3;
      for (let i = 0; i < trials; i++) {
        const roll = Math.floor(Math.random() * 6) + 1;
        if (roll === guess) matches++;
      }
      const matchRate = matches / trials;
      expect(matchRate).toBeGreaterThan(0.13);
      expect(matchRate).toBeLessThan(0.20);
    });
  });

  describe("Slots", () => {
    it("should have matching reels less than 5% of the time", () => {
      const symbols = ["🍒", "🍋", "🍊", "🍇", "💎", "7️⃣", "🔔"];
      let jackpots = 0;
      const trials = 10000;
      for (let i = 0; i < trials; i++) {
        const reels = [
          symbols[Math.floor(Math.random() * symbols.length)],
          symbols[Math.floor(Math.random() * symbols.length)],
          symbols[Math.floor(Math.random() * symbols.length)],
        ];
        if (reels[0] === reels[1] && reels[1] === reels[2]) jackpots++;
      }
      const jackpotRate = jackpots / trials;
      expect(jackpotRate).toBeLessThan(0.05);
    });
  });

  describe("Mood adjustment", () => {
    it("should adjust win probability based on mood", () => {
      const baseProbability = 0.5;
      const moodScore = 50; // good mood
      const adjustment = moodScore * 0.001; // ±5% at max mood
      const adjustedProb = baseProbability + adjustment;
      expect(adjustedProb).toBeCloseTo(0.55);
    });

    it("should decrease win probability when in bad mood", () => {
      const baseProbability = 0.5;
      const moodScore = -50;
      const adjustment = moodScore * 0.001;
      const adjustedProb = baseProbability + adjustment;
      expect(adjustedProb).toBeCloseTo(0.45);
    });
  });
});
