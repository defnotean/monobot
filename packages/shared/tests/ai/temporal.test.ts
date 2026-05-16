import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import {
  getTimeOfDay,
  getDayVibe,
  getSeason,
  markDailyGreeting,
  buildTemporalContext,
  _clearDailyGreetingMap,
} from "../../src/ai/temporal.js";

beforeEach(() => _clearDailyGreetingMap());

describe("getTimeOfDay", () => {
  it.each([
    [0,  "very late"],
    [3,  "very late"],
    [7,  "morning"],
    [12, "late morning"],
    [15, "afternoon"],
    [19, "evening"],
    [22, "late night"],
  ])("hour %i -> label contains %s", (hour, expected) => {
    expect(getTimeOfDay(hour).label).toContain(expected);
  });
});

describe("getDayVibe", () => {
  it("returns a named vibe for every day 0-6", () => {
    for (let i = 0; i < 7; i++) {
      const v = getDayVibe(i);
      expect(v.name).toBeTruthy();
      expect(v.vibe).toBeTruthy();
    }
  });

  it("falls back to Sunday for out-of-range indices rather than crashing", () => {
    expect(getDayVibe(99).name).toBe("Sunday");
  });
});

describe("getSeason", () => {
  it.each([
    [0,  "winter"],
    [2,  "spring"],
    [5,  "summer"],
    [8,  "fall"],
    [11, "winter"],
  ])("month %i -> %s", (m, name) => {
    expect(getSeason(m).name).toBe(name);
  });
});

describe("markDailyGreeting", () => {
  it("flags the first call today as first, subsequent as not", () => {
    const a = markDailyGreeting("u1");
    const b = markDailyGreeting("u1");
    expect(a.isFirstToday).toBe(true);
    expect(b.isFirstToday).toBe(false);
  });

  it("tracks different users independently", () => {
    markDailyGreeting("u1");
    expect(markDailyGreeting("u2").isFirstToday).toBe(true);
  });
});

describe("buildTemporalContext", () => {
  it("always includes TIME, DAY, and SEASON fragments", () => {
    const ctx = buildTemporalContext({ now: new Date(2026, 5, 15, 14, 30) });
    expect(ctx).toContain("[TIME:");
    expect(ctx).toContain("[DAY:");
    expect(ctx).toContain("[SEASON:");
  });

  it("adds a DAILY fragment only on first call per user per day", () => {
    const userId = "u-daily-test";
    const first = buildTemporalContext({ userId, displayName: "ean" });
    const second = buildTemporalContext({ userId, displayName: "ean" });
    expect(first).toContain("[DAILY:");
    expect(second).not.toContain("[DAILY:");
  });

  it("includes notable date note on halloween", () => {
    const ctx = buildTemporalContext({ now: new Date(2026, 9, 31, 12, 0) });
    expect(ctx).toContain("halloween");
  });

  it("does not include DAILY fragment when userId not supplied", () => {
    const ctx = buildTemporalContext({});
    expect(ctx).not.toContain("[DAILY:");
  });
});
