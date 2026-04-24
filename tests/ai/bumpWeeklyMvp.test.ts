import { describe, it, expect, vi } from "vitest";

// Mock supabase + getGuildSettings so weekly-MVP tick logic can be driven
// with synthetic state.
const guildSettings = new Map();
const bumps = [];

vi.mock("../../database.js", () => ({
  getGuildSettings: (id: string) => guildSettings.get(id) || {},
  setGuildSetting: (id: string, key: string, val: unknown) => {
    const cur = guildSettings.get(id) || {};
    if (val == null) delete cur[key]; else cur[key] = val;
    guildSettings.set(id, cur);
  },
  getSupabase: () => ({
    from() {
      return {
        _filters: [],
        _count: false,
        _order: null,
        _limit: null,
        select(_cols: string, opts: any) { if (opts?.count) this._count = true; return this; },
        eq(col: string, val: any) { this._filters.push((r: any) => r[col] === val); return this; },
        gte(col: string, val: any) { this._filters.push((r: any) => r[col] >= val); return this; },
        order(col: string, opts: any) { this._order = { col, asc: opts?.ascending }; return this; },
        limit(n: number) { this._limit = n; return this; },
        async then(resolve: any) {
          let data = bumps.filter(r => this._filters.every((f: any) => f(r)));
          if (this._order) {
            const { col, asc } = this._order;
            data = [...data].sort((a: any, b: any) => asc ? (a[col] > b[col] ? 1 : -1) : (a[col] < b[col] ? 1 : -1));
          }
          if (this._limit) data = data.slice(0, this._limit);
          if (this._count) return resolve({ count: data.length, error: null });
          resolve({ data, error: null });
        },
      };
    },
  }),
}));

vi.mock("../../ai/bumpUserPrefs.js", () => ({
  getUserPrefs: async (_u: string) => ({ personal_ping_enabled: false, weekly_mvp_optout: false }),
}));

vi.mock("../../ai/bumpAnalytics.js", () => ({
  getBumpLeaderboard: async () => [{ user_id: "u1", count: 7 }],
  getBumpCount: async () => 7,
  getGuildStreak: async () => 0,
}));

// @ts-expect-error
import * as celebrations from "../../ai/bumpCelebrations.js";

function makeClient(userInGuild = true) {
  const dmSend = vi.fn();
  const member = {
    id: "u1",
    displayName: "toyou",
    user: { bot: false },
    createDM: vi.fn().mockResolvedValue({ send: dmSend }),
  };
  const guild = {
    id: "g1",
    name: "TestServer",
    members: {
      cache: userInGuild ? new Map([["u1", member]]) : new Map(),
      fetch: async () => userInGuild ? member : null,
    },
  };
  return { client: { guilds: { cache: new Map([["g1", guild]]) } } as any, dmSend };
}

describe("bumpCelebrations.runWeeklyMvpTick", () => {
  it("skips when not Sunday", async () => {
    guildSettings.clear();
    const { client } = makeClient();
    // Force Monday.
    const monday = new Date("2026-04-20T15:00:00Z");
    const r = await celebrations.runWeeklyMvpTick(client, { nowDate: monday });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("not-sunday");
  });

  it("skips when outside the hour window on Sunday", async () => {
    guildSettings.clear();
    const { client } = makeClient();
    const sundayEarly = new Date("2026-04-19T10:00:00Z");
    const r = await celebrations.runWeeklyMvpTick(client, { nowDate: sundayEarly });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("outside-window");
  });

  it("fires (returns fired:true) when Sunday in window", async () => {
    guildSettings.clear();
    const { client } = makeClient();
    const sunday = new Date("2026-04-19T15:30:00Z");
    const r = await celebrations.runWeeklyMvpTick(client, { nowDate: sunday });
    expect(r.fired).toBe(true);
    expect(r.weekKey).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("is idempotent within the same ISO week", async () => {
    guildSettings.clear();
    const { client } = makeClient();
    const sunday = new Date("2026-04-19T15:30:00Z");
    await celebrations.runWeeklyMvpTick(client, { nowDate: sunday });
    // Second call should see bump_mvp_week_sent and skip the guild loop's DM
    // branch without error.
    const r2 = await celebrations.runWeeklyMvpTick(client, { nowDate: sunday });
    expect(r2.fired).toBe(true);
    expect(r2.dmsSent).toBe(0);
  });

  it("skips the DM branch when admin disabled (bump_mvp_enabled=false)", async () => {
    guildSettings.clear();
    guildSettings.set("g1", { bump_mvp_enabled: false });
    const { client, dmSend } = makeClient();
    const sunday = new Date("2026-04-19T15:30:00Z");
    const r = await celebrations.runWeeklyMvpTick(client, { nowDate: sunday });
    expect(r.fired).toBe(true);
    expect(r.dmsSent).toBe(0);
    expect(dmSend).not.toHaveBeenCalled();
    // Even for disabled guilds we mark the week-sent so we don't retry all
    // day — that's the correct behavior for the disable flag.
    expect(guildSettings.get("g1").bump_mvp_week_sent).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("bumpCelebrations.buildStreakLostLine", () => {
  it("returns the default line when no template set", () => {
    const line = celebrations.buildStreakLostLine({}, 12);
    expect(line).toContain("12");
    expect(line).toContain("streak");
  });

  it("respects a custom streak_lost template with {streak} substitution", () => {
    const line = celebrations.buildStreakLostLine(
      { bump_celebration_templates: { streak_lost: "we lost {streak}, rip" } },
      20
    );
    expect(line).toBe("we lost 20, rip");
  });

  it("returns empty string when lostLength is 0", () => {
    expect(celebrations.buildStreakLostLine({}, 0)).toBe("");
  });
});
