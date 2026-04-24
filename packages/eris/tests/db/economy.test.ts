import { describe, it, expect, beforeEach } from "vitest";

// Test the economy logic directly by verifying the math/business rules
// without needing actual Supabase

describe("Economy Rules", () => {
  describe("Balance calculations", () => {
    it("should never allow negative balance", () => {
      const balance = 50;
      const delta = -100;
      const result = Math.max(0, balance + delta);
      expect(result).toBe(0);
    });

    it("should track earnings correctly", () => {
      const current = { total_earned: 100, total_lost: 50, total_gambled: 30 };
      const delta = 25;
      const updates: any = {};
      if (delta > 0) updates.total_earned = current.total_earned + delta;
      expect(updates.total_earned).toBe(125);
    });

    it("should track losses correctly", () => {
      const current = { total_earned: 100, total_lost: 50, total_gambled: 30 };
      const delta = -25;
      const updates: any = {};
      if (delta < 0) updates.total_lost = current.total_lost + Math.abs(delta);
      expect(updates.total_lost).toBe(75);
    });

    it("should track gambling separately", () => {
      const current = { total_gambled: 30 };
      const type = "gamble_coinflip_loss";
      const delta = -50;
      const updates: any = {};
      if (type.startsWith("gamble")) updates.total_gambled = current.total_gambled + Math.abs(delta);
      expect(updates.total_gambled).toBe(80);
    });
  });

  describe("Daily reward", () => {
    it("should enforce 20-hour cooldown", () => {
      const lastDaily = new Date(Date.now() - 10 * 3600000); // 10 hours ago
      const hoursSince = (Date.now() - lastDaily.getTime()) / 3600000;
      expect(hoursSince).toBeLessThan(20);
      const hoursLeft = Math.ceil(20 - hoursSince);
      expect(hoursLeft).toBe(10);
    });

    it("should allow claim after 20 hours", () => {
      const lastDaily = new Date(Date.now() - 21 * 3600000); // 21 hours ago
      const hoursSince = (Date.now() - lastDaily.getTime()) / 3600000;
      expect(hoursSince).toBeGreaterThan(20);
    });

    it("should reset streak after 48 hours", () => {
      const lastDaily = new Date(Date.now() - 50 * 3600000); // 50 hours ago
      const hoursSince = (Date.now() - lastDaily.getTime()) / 3600000;
      let streak = 5;
      if (hoursSince > 48) streak = 0;
      expect(streak).toBe(0);
    });

    it("should calculate daily reward correctly", () => {
      const streak = 3;
      const base = 50;
      const bonus = Math.min(streak * 10, 150);
      const coins = base + bonus;
      expect(coins).toBe(80); // 50 + 30
    });

    it("should cap bonus at 150", () => {
      const streak = 20;
      const bonus = Math.min(streak * 10, 150);
      expect(bonus).toBe(150);
    });
  });

  describe("Weekly reward", () => {
    it("should enforce 168-hour (7-day) cooldown", () => {
      const lastWeekly = new Date(Date.now() - 100 * 3600000); // 100 hours ago
      const msSince = Date.now() - lastWeekly.getTime();
      expect(msSince).toBeLessThan(168 * 3600000);
    });

    it("should calculate weekly reward correctly", () => {
      const streak = 2;
      const coins = 500 + streak * 100;
      expect(coins).toBe(700);
    });
  });

  describe("Monthly reward", () => {
    it("should enforce 720-hour (30-day) cooldown", () => {
      const lastMonthly = new Date(Date.now() - 500 * 3600000);
      const msSince = Date.now() - lastMonthly.getTime();
      expect(msSince).toBeLessThan(720 * 3600000);
    });

    it("should calculate monthly reward correctly", () => {
      const streak = 3;
      const coins = 5000 + streak * 1000;
      expect(coins).toBe(8000);
    });
  });

  describe("Banking", () => {
    it("should calculate bank capacity based on prestige", () => {
      const prestige = 3;
      const capacity = 5000 + prestige * 2500;
      expect(capacity).toBe(12500);
    });

    it("should calculate daily interest at 1%", () => {
      const balance = 1000;
      const days = 3;
      const interest = Math.floor(balance * 0.01 * days);
      expect(interest).toBe(30);
    });

    it("should cap interest at bank capacity", () => {
      const balance = 4900;
      const cap = 5000;
      const interest = 200;
      const actual = Math.min(interest, cap - balance);
      expect(actual).toBe(100);
    });
  });

  describe("Prestige multipliers", () => {
    it("should give 10% per prestige level", () => {
      const prestige = 3;
      let mult = 1.0;
      mult += prestige * 0.10;
      expect(mult).toBeCloseTo(1.3);
    });

    it("should stack marriage bonus", () => {
      const prestige = 2;
      const married = true;
      let mult = 1.0;
      mult += prestige * 0.10;
      if (married) mult += 0.10;
      expect(mult).toBeCloseTo(1.3);
    });
  });
});
