import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Unit coverage for the OPT-IN daily AI-call ceiling. The module reads caps
// from process.env (AI_DAILY_USER_CAP / AI_DAILY_GUILD_CAP) and keys an
// in-memory daily counter by userId/guildId that resets at UTC day rollover.
// We inject a clock via _setClock so the rollover + Map eviction are testable
// without waiting a real day.

// @ts-expect-error - importing JS module without types
import * as budget from "../../utils/aiBudget.js";

const DAY_MS = 86_400_000;

beforeEach(() => {
  delete process.env.AI_DAILY_USER_CAP;
  delete process.env.AI_DAILY_GUILD_CAP;
  budget._reset();
});

afterEach(() => {
  delete process.env.AI_DAILY_USER_CAP;
  delete process.env.AI_DAILY_GUILD_CAP;
  budget._reset();
});

describe("aiBudget (eris) — caps unset = pure pass-through", () => {
  it("checkBudget never gates and budgetEnabled is false when no cap is set", () => {
    expect(budget.budgetEnabled()).toBe(false);
    for (let i = 0; i < 1000; i++) {
      budget.incrementBudget({ userId: "u1", guildId: "g1" });
      expect(budget.checkBudget({ userId: "u1", guildId: "g1" }).exceeded).toBe(false);
    }
  });

  it("0 / non-numeric / negative caps are treated as unlimited", () => {
    for (const v of ["0", "", "abc", "-5"]) {
      process.env.AI_DAILY_USER_CAP = v;
      budget._reset();
      expect(budget.budgetEnabled()).toBe(false);
      budget.incrementBudget({ userId: "u1" });
      budget.incrementBudget({ userId: "u1" });
      expect(budget.checkBudget({ userId: "u1" }).exceeded).toBe(false);
    }
  });
});

describe("aiBudget (eris) — per-user cap", () => {
  it("gates the N+1th AI-eligible message in a UTC day", () => {
    process.env.AI_DAILY_USER_CAP = "3";
    budget._setClock(() => 0); // day 0
    budget._reset();
    process.env.AI_DAILY_USER_CAP = "3";

    // First 3 proceed (check passes, then increment as the gate would do).
    for (let i = 0; i < 3; i++) {
      expect(budget.checkBudget({ userId: "u1" }).exceeded).toBe(false);
      budget.incrementBudget({ userId: "u1" });
    }
    // 4th is gated — scope reported as "user".
    const gated = budget.checkBudget({ userId: "u1" });
    expect(gated.exceeded).toBe(true);
    expect(gated.scope).toBe("user");

    // A different user is independent.
    expect(budget.checkBudget({ userId: "u2" }).exceeded).toBe(false);
  });
});

describe("aiBudget (eris) — per-guild cap", () => {
  it("gates once the guild total hits the cap regardless of which user", () => {
    process.env.AI_DAILY_GUILD_CAP = "2";
    budget._setClock(() => 0);
    budget._reset();
    process.env.AI_DAILY_GUILD_CAP = "2";

    budget.incrementBudget({ userId: "a", guildId: "g1" });
    budget.incrementBudget({ userId: "b", guildId: "g1" });
    const gated = budget.checkBudget({ userId: "c", guildId: "g1" });
    expect(gated.exceeded).toBe(true);
    expect(gated.scope).toBe("guild");

    // A different guild is independent.
    expect(budget.checkBudget({ userId: "c", guildId: "g2" }).exceeded).toBe(false);
  });
});

describe("aiBudget (eris) — UTC day rollover", () => {
  it("resets the counter when the UTC day advances", () => {
    process.env.AI_DAILY_USER_CAP = "2";
    let nowMs = 0;
    budget._setClock(() => nowMs);
    budget._reset();
    budget._setClock(() => nowMs);
    process.env.AI_DAILY_USER_CAP = "2";

    budget.incrementBudget({ userId: "u1" });
    budget.incrementBudget({ userId: "u1" });
    expect(budget.checkBudget({ userId: "u1" }).exceeded).toBe(true);

    // Advance one full UTC day — the count effectively resets.
    nowMs = DAY_MS;
    expect(budget.checkBudget({ userId: "u1" }).exceeded).toBe(false);
    budget.incrementBudget({ userId: "u1" });
    budget.incrementBudget({ userId: "u1" });
    expect(budget.checkBudget({ userId: "u1" }).exceeded).toBe(true);
  });
});

describe("aiBudget (eris) — Map eviction on rollover (no leak)", () => {
  it("drops prior-day count + notice entries when the day advances", () => {
    process.env.AI_DAILY_USER_CAP = "1";
    let nowMs = 0;
    budget._setClock(() => nowMs);
    budget._reset();
    budget._setClock(() => nowMs);
    process.env.AI_DAILY_USER_CAP = "1";

    // Populate many distinct users on day 0, in both Maps.
    for (let i = 0; i < 50; i++) {
      budget.incrementBudget({ userId: `u${i}` });
      budget.shouldNotify("user", `u${i}`);
    }
    expect(budget._countSize()).toBe(50);
    expect(budget._notifySize()).toBe(50);

    // Advance a day and touch the module once — the sweep evicts every stale
    // (prior-day) entry from BOTH Maps, so neither grows unbounded across days.
    nowMs = DAY_MS;
    budget.checkBudget({ userId: "fresh" });
    expect(budget._countSize()).toBe(0);
    expect(budget._notifySize()).toBe(0);
  });
});

describe("aiBudget (eris) — shouldNotify is one-time-per-day per scope", () => {
  it("returns true once per UTC day then false, and re-arms next day", () => {
    let nowMs = 0;
    budget._setClock(() => nowMs);
    budget._reset();
    budget._setClock(() => nowMs);

    expect(budget.shouldNotify("user", "u1")).toBe(true);
    expect(budget.shouldNotify("user", "u1")).toBe(false);
    expect(budget.shouldNotify("user", "u2")).toBe(true); // different id, independent

    nowMs = DAY_MS;
    expect(budget.shouldNotify("user", "u1")).toBe(true); // re-armed next day
  });
});
