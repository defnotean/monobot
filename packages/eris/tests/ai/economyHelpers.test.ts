import { describe, it, expect, afterEach, vi } from "vitest";

// ai/economy.js holds PURE helpers (no Supabase, no Discord): the achievement
// condition evaluator, the loan-interest calculator, the random daily-challenge
// generator, the mystery-box loot table, and the static catalogs. These tests
// exercise the real branch/boundary logic — Math.random is stubbed where the
// output is probabilistic so the assertions stay deterministic.
import {
  checkAchievementCondition,
  calculateLoanTotal,
  generateChallenge,
  openMysteryBox,
  ACHIEVEMENTS,
  CHALLENGE_TEMPLATES,
  DEFAULT_SHOP_ITEMS,
} from "../../ai/economy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkAchievementCondition", () => {
  it("first_bet requires any gambling", () => {
    expect(checkAchievementCondition("first_bet", { totalGambled: 0 })).toBe(false);
    expect(checkAchievementCondition("first_bet", { totalGambled: 1 })).toBe(true);
  });

  it("high_roller needs a single bet of 500+ (boundary inclusive)", () => {
    expect(checkAchievementCondition("high_roller", { lastBet: 499 })).toBe(false);
    expect(checkAchievementCondition("high_roller", { lastBet: 500 })).toBe(true);
  });

  it("broke is true at or below zero balance", () => {
    expect(checkAchievementCondition("broke", { balance: 0 })).toBe(true);
    expect(checkAchievementCondition("broke", { balance: -5 })).toBe(true);
    expect(checkAchievementCondition("broke", { balance: 1 })).toBe(false);
  });

  it("rich / mega_rich gate on balance thresholds", () => {
    expect(checkAchievementCondition("rich", { balance: 4999 })).toBe(false);
    expect(checkAchievementCondition("rich", { balance: 5000 })).toBe(true);
    expect(checkAchievementCondition("mega_rich", { balance: 9999 })).toBe(false);
    expect(checkAchievementCondition("mega_rich", { balance: 10000 })).toBe(true);
  });

  it("win-streak achievements gate on currentStreak", () => {
    expect(checkAchievementCondition("streak_3", { currentStreak: 2 })).toBe(false);
    expect(checkAchievementCondition("streak_3", { currentStreak: 3 })).toBe(true);
    expect(checkAchievementCondition("streak_5", { currentStreak: 5 })).toBe(true);
    expect(checkAchievementCondition("streak_10", { currentStreak: 9 })).toBe(false);
    expect(checkAchievementCondition("streak_10", { currentStreak: 10 })).toBe(true);
  });

  it("daily-streak achievements gate on dailyStreak", () => {
    expect(checkAchievementCondition("daily_7", { dailyStreak: 7 })).toBe(true);
    expect(checkAchievementCondition("daily_7", { dailyStreak: 6 })).toBe(false);
    expect(checkAchievementCondition("daily_30", { dailyStreak: 30 })).toBe(true);
    expect(checkAchievementCondition("daily_30", { dailyStreak: 29 })).toBe(false);
  });

  it("activity counters (trivia, roulette, fish, hunt, work, deposits)", () => {
    expect(checkAchievementCondition("trivia_10", { triviaCorrect: 10 })).toBe(true);
    expect(checkAchievementCondition("trivia_10", { triviaCorrect: 9 })).toBe(false);
    expect(checkAchievementCondition("roulette_survive", { rouletteSurvived: 5 })).toBe(true);
    expect(checkAchievementCondition("first_fish", { fishCaught: 1 })).toBe(true);
    expect(checkAchievementCondition("first_fish", { fishCaught: 0 })).toBe(false);
    expect(checkAchievementCondition("first_hunt", { animalsCaught: 2 })).toBe(true);
    expect(checkAchievementCondition("hard_worker", { jobsWorked: 1 })).toBe(true);
    expect(checkAchievementCondition("first_deposit", { bankDeposits: 1 })).toBe(true);
    expect(checkAchievementCondition("first_deposit", { bankDeposits: 0 })).toBe(false);
  });

  it("event-triggered / unknown keys return false (default branch)", () => {
    expect(checkAchievementCondition("first_rob", {})).toBe(false);
    expect(checkAchievementCondition("just_married", {})).toBe(false);
    expect(checkAchievementCondition("totally_made_up_key", { balance: 999999 })).toBe(false);
  });
});

describe("calculateLoanTotal", () => {
  it("applies interest with ceil and no penalty when not overdue", () => {
    // 1000 * 1.1 = 1100 exactly.
    expect(calculateLoanTotal(1000, 0.1)).toBe(1100);
    // ceil rounds up a fractional base.
    expect(calculateLoanTotal(1001, 0.1)).toBe(Math.ceil(1001 * 1.1)); // 1102
  });

  it("zero/negative hoursOverdue skips the penalty", () => {
    expect(calculateLoanTotal(1000, 0.1, 0)).toBe(1100);
    expect(calculateLoanTotal(1000, 0.1, -3)).toBe(1100);
  });

  it("adds a 5%/hour penalty on the base", () => {
    // base = 1100; 2h overdue → 10% penalty → ceil(110) = 110 → 1210.
    expect(calculateLoanTotal(1000, 0.1, 2)).toBe(1210);
  });

  it("caps the penalty multiplier at 5x base (max total 6x base)", () => {
    // base = 1100; 1000h overdue would be 50x but multiplier caps at 5.
    // penalty = ceil(1100 * 5) = 5500 → total 6600.
    expect(calculateLoanTotal(1000, 0.1, 1000)).toBe(6600);
    // Right at the cap boundary: 100h * 0.05 = 5.0 (exactly the cap).
    expect(calculateLoanTotal(1000, 0.1, 100)).toBe(6600);
  });
});

describe("generateChallenge", () => {
  it("picks a known template and a valid difficulty tier", () => {
    // Force template index 0 (coinflip_wins) and difficulty tier 0.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const c = generateChallenge();
    const tmpl = CHALLENGE_TEMPLATES[0];
    expect(c.type).toBe(tmpl.type);
    expect(c.target).toBe(tmpl.target[0]);
    expect(c.reward).toBe(tmpl.reward[0]);
    // The {target} placeholder is substituted into the description.
    expect(c.description).toContain(String(tmpl.target[0]));
    expect(c.description).not.toContain("{target}");
  });

  it("the chosen target/reward always come from the matched template", () => {
    // 0.999... pushes Math.floor to the last index of both arrays.
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const c = generateChallenge();
    const tmpl = CHALLENGE_TEMPLATES[CHALLENGE_TEMPLATES.length - 1];
    expect(c.type).toBe(tmpl.type);
    expect(c.target).toBe(tmpl.target[tmpl.target.length - 1]);
    expect(c.reward).toBe(tmpl.reward[tmpl.reward.length - 1]);
  });
});

describe("openMysteryBox", () => {
  const cases: Array<[number, number, string]> = [
    [0.0, 1000, "LEGENDARY"],
    [0.049, 1000, "LEGENDARY"],
    [0.05, 500, "EPIC"],
    [0.14, 500, "EPIC"],
    [0.15, 200, "RARE"],
    [0.29, 200, "RARE"],
    [0.3, 100, "COMMON"],
    [0.54, 100, "COMMON"],
    [0.55, 50, "meh"],
    [0.79, 50, "meh"],
    [0.8, 10, "lol"],
    [0.94, 10, "lol"],
    [0.95, 1, "CURSED"],
    [0.999, 1, "CURSED"],
  ];

  for (const [roll, coins, label] of cases) {
    it(`roll ${roll} → ${coins} coins (${label})`, () => {
      vi.spyOn(Math, "random").mockReturnValue(roll);
      const out = openMysteryBox();
      expect(out.coins).toBe(coins);
      expect(out.label).toContain(label);
    });
  }
});

describe("static catalogs", () => {
  it("ACHIEVEMENTS entries all carry name/desc/icon", () => {
    const entries = Object.values(ACHIEVEMENTS);
    expect(entries.length).toBeGreaterThan(20);
    for (const a of entries) {
      expect(typeof a.name).toBe("string");
      expect(typeof a.desc).toBe("string");
      expect(typeof a.icon).toBe("string");
    }
  });

  it("CHALLENGE_TEMPLATES target/reward arrays are aligned in length", () => {
    for (const t of CHALLENGE_TEMPLATES) {
      expect(t.target.length).toBe(t.reward.length);
      expect(t.target.length).toBeGreaterThan(0);
    }
  });

  it("DEFAULT_SHOP_ITEMS all have a positive price, a name and a type", () => {
    expect(DEFAULT_SHOP_ITEMS.length).toBeGreaterThan(10);
    for (const item of DEFAULT_SHOP_ITEMS) {
      expect(typeof item.name).toBe("string");
      expect(typeof item.type).toBe("string");
      expect(item.price).toBeGreaterThan(0);
    }
  });

  it("shop item names are unique (no accidental duplicate catalog rows)", () => {
    const names = DEFAULT_SHOP_ITEMS.map(i => i.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
