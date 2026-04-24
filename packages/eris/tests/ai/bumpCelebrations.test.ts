import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock Supabase-backed modules so this test stays pure-in-memory.
const guildSettings = new Map();
vi.mock("../../database.js", () => ({
  getSupabase: () => null,
  getGuildSettings: (id: string) => guildSettings.get(id) || {},
  setGuildSetting: (id: string, key: string, val: unknown) => {
    const cur = guildSettings.get(id) || {};
    cur[key] = val;
    guildSettings.set(id, cur);
  },
  getMood: () => ({ mood_score: 0, energy: 50 }),
}));

vi.mock("../../ai/bumpAnalytics.js", () => {
  // Drives the streak values the tests control
  const state = { guildStreak: 0 };
  return {
    __setStreak(n: number) { state.guildStreak = n; },
    getGuildStreak: async () => state.guildStreak,
  };
});

// @ts-expect-error
import * as celebrations from "../../ai/bumpCelebrations.js";
import * as analytics from "../../ai/bumpAnalytics.js";

beforeEach(() => {
  guildSettings.clear();
  (analytics as any).__setStreak(0);
});

// Minimal fake client/channel — just enough surface for celebration sends.
function fakeClient() {
  const sent: any[] = [];
  const channel = { isTextBased: () => true, send: vi.fn(async (payload: any) => { sent.push(payload); return { id: "m" }; }) };
  const guild = {
    id: "g1",
    channels: { cache: new Map([["c1", channel]]), fetch: async () => channel },
  };
  return {
    client: { guilds: { cache: new Map([["g1", guild]]) } } as any,
    channel,
    sent,
  };
}

describe("bumpCelebrations.maybeCelebrateStreakMilestone", () => {
  it("celebrates on a 7-day streak", async () => {
    const { client, sent } = fakeClient();
    guildSettings.set("g1", { bump_channel_id: "c1" });
    (analytics as any).__setStreak(7);
    await celebrations.maybeCelebrateStreakMilestone(client, { guildId: "g1", service: "disboard" });
    expect(sent).toHaveLength(1);
    expect(sent[0].embeds[0].data.title).toMatch(/7-day bump streak/);
  });

  it("does NOT celebrate on non-milestone streaks", async () => {
    const { client, sent } = fakeClient();
    guildSettings.set("g1", { bump_channel_id: "c1" });
    (analytics as any).__setStreak(10);
    await celebrations.maybeCelebrateStreakMilestone(client, { guildId: "g1" });
    expect(sent).toHaveLength(0);
  });

  it("does NOT celebrate the same milestone twice inside 20h", async () => {
    const { client, sent } = fakeClient();
    guildSettings.set("g1", { bump_channel_id: "c1" });
    (analytics as any).__setStreak(7);
    await celebrations.maybeCelebrateStreakMilestone(client, { guildId: "g1" });
    await celebrations.maybeCelebrateStreakMilestone(client, { guildId: "g1" });
    expect(sent).toHaveLength(1);
  });

  it("uses reminder channel if configured over bump channel", async () => {
    const { client, sent } = fakeClient();
    guildSettings.set("g1", { bump_channel_id: "ignored", bump_reminder_channel_id: "c1" });
    (analytics as any).__setStreak(30);
    await celebrations.maybeCelebrateStreakMilestone(client, { guildId: "g1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].embeds[0].data.title).toMatch(/30-day/);
  });
});

describe("bumpCelebrations.detectStreakLost", () => {
  it("returns null when no baseline exists", async () => {
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBeNull();
  });

  it("returns null when baseline is small (<5)", async () => {
    guildSettings.set("g1", { bump_streak_baseline_disboard: { streak: 3, at: Date.now() } });
    (analytics as any).__setStreak(0);
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBeNull();
  });

  it("returns the prior streak length when baseline was substantial and current is 0", async () => {
    guildSettings.set("g1", { bump_streak_baseline_disboard: { streak: 12, at: Date.now() } });
    (analytics as any).__setStreak(0);
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBe(12);
  });

  it("does not fire twice — baseline is cleared after detection", async () => {
    guildSettings.set("g1", { bump_streak_baseline_disboard: { streak: 10, at: Date.now() } });
    (analytics as any).__setStreak(0);
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBe(10);
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBeNull();
  });

  it("returns null when streak is still mostly intact (current >= baseline)", async () => {
    guildSettings.set("g1", { bump_streak_baseline_disboard: { streak: 10, at: Date.now() } });
    (analytics as any).__setStreak(11);
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBeNull();
  });

  it("treats a 1-day current streak as a break (catching yesterday's bump but losing N-day history)", async () => {
    guildSettings.set("g1", { bump_streak_baseline_disboard: { streak: 15, at: Date.now() } });
    (analytics as any).__setStreak(1);
    expect(await celebrations.detectStreakLost({ guildId: "g1" })).toBe(15);
  });
});

describe("bumpCelebrations.maybeCelebrateBumpathon", () => {
  it("does nothing when no active bumpathon", async () => {
    const { client, sent } = fakeClient();
    await celebrations.maybeCelebrateBumpathon(client, "g1");
    expect(sent).toHaveLength(0);
  });

  it("does nothing when bumpathon is already completed", async () => {
    const { client, sent } = fakeClient();
    guildSettings.set("g1", {
      bumpathon: { goal: 10, startedAt: Date.now() - 1000, endsAt: Date.now() + 60_000, completed: true },
      bump_channel_id: "c1",
    });
    await celebrations.maybeCelebrateBumpathon(client, "g1");
    expect(sent).toHaveLength(0);
  });

  it("does nothing when bumpathon has expired (watcher handles that path)", async () => {
    const { client, sent } = fakeClient();
    guildSettings.set("g1", {
      bumpathon: { goal: 1, startedAt: Date.now() - 60_000, endsAt: Date.now() - 10_000 },
      bump_channel_id: "c1",
    });
    await celebrations.maybeCelebrateBumpathon(client, "g1");
    expect(sent).toHaveLength(0);
  });
});
