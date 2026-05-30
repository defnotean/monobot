import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, repliedText } from "../../_helpers/mockDiscord.js";

// bumps.execute dynamically imports analytics/prefs modules per-branch.
vi.mock("../../../ai/bumpAnalytics.js", () => ({
  getBumpLeaderboard: (...a: any[]) => mockLeaderboard(...a),
  getGuildStreak: (...a: any[]) => mockGuildStreak(...a),
  getBumpCount: (...a: any[]) => mockBumpCount(...a),
  getUserStreak: (...a: any[]) => mockUserStreak(...a),
  getBumpsPerDay: (...a: any[]) => mockBumpsPerDay(...a),
}));
vi.mock("../../../ai/bumpCelebrations.js", () => ({
  getBestRankInPeriod: (...a: any[]) => mockBestRank(...a),
}));
vi.mock("../../../ai/bumpUserPrefs.js", () => ({
  setUserPref: (...a: any[]) => mockSetUserPref(...a),
}));

let mockLeaderboard: any, mockGuildStreak: any, mockBumpCount: any, mockUserStreak: any,
  mockBumpsPerDay: any, mockBestRank: any, mockSetUserPref: any;

import * as bumpsCmd from "../../../commands/utility/bumps.js";

beforeEach(() => {
  mockLeaderboard = vi.fn(async () => []);
  mockGuildStreak = vi.fn(async () => 0);
  mockBumpCount = vi.fn(async () => 0);
  mockUserStreak = vi.fn(async () => 0);
  mockBumpsPerDay = vi.fn(async () => []);
  mockBestRank = vi.fn(async () => null);
  mockSetUserPref = vi.fn(async () => ({ ok: true }));
});

function inter(sub: string, options: any = {}) {
  return makeInteraction({
    guild: makeGuild({ id: "g1", name: "S" }),
    user: makeUser({ id: "u1", username: "Me" }),
    subcommand: sub,
    options,
  });
}

describe("utility/bumps guild guard", () => {
  it("requires a guild context", async () => {
    const interaction = makeInteraction({ subcommand: "me", options: { user: null } });
    interaction.guild = null;
    await bumpsCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("only works in servers");
  });
});

describe("utility/bumps leaderboard", () => {
  it("shows an empty-state message when no bumps are recorded", async () => {
    mockLeaderboard.mockResolvedValue([]);
    const interaction = inter("leaderboard", { period: null, service: null });
    await bumpsCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("no bumps recorded yet");
  });

  it("renders ranked rows with medals for the top bumpers", async () => {
    mockLeaderboard.mockResolvedValue([
      { user_id: "a", count: 9 },
      { user_id: "b", count: 4 },
    ]);
    mockGuildStreak.mockResolvedValue(3);
    const interaction = inter("leaderboard", { period: "7", service: "disboard" });
    await bumpsCmd.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("🥇");
    expect(text).toContain("9 bumps");
    expect(text).toContain("4 bumps");
    // leaderboard called with parsed period + service
    expect(mockLeaderboard).toHaveBeenCalledWith("g1", { limit: 10, periodDays: 7, service: "disboard" });
  });
});

describe("utility/bumps me", () => {
  it("reports total / weekly / streak for the caller by default", async () => {
    mockBumpCount.mockImplementation(async (_id: string, _g: string, opts: any) => (opts.periodDays === 7 ? 2 : 11));
    mockUserStreak.mockResolvedValue(5);
    const interaction = inter("me", { user: null });
    await bumpsCmd.execute(interaction);
    const payload = interaction.reply.mock.calls[0][0];
    const embed = payload.embeds[0].data ?? payload.embeds[0];
    const f = (n: string) => embed.fields.find((x: any) => x.name === n)?.value;
    expect(f("Total bumps")).toBe("11");
    expect(f("This week")).toBe("2");
    expect(f("Day streak")).toBe("5");
  });
});

describe("utility/bumps dm", () => {
  it("saves the opt-in pref and confirms", async () => {
    mockSetUserPref.mockResolvedValue({ ok: true });
    const interaction = inter("dm", { enabled: true });
    await bumpsCmd.execute(interaction);
    expect(mockSetUserPref).toHaveBeenCalledWith("u1", "personal_ping_enabled", true, "irene");
    expect(repliedText(interaction)).toContain("you'll get a DM");
  });

  it("surfaces the error when the pref write fails", async () => {
    mockSetUserPref.mockResolvedValue({ ok: false, error: "db down" });
    const interaction = inter("dm", { enabled: true });
    await bumpsCmd.execute(interaction);
    expect(repliedText(interaction)).toContain("db down");
  });
});
