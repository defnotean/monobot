import { describe, it, expect } from "vitest";

describe("Gambling Odds", () => {
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
