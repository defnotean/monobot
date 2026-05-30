import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../ai/bumpAnalytics.js", () => ({
  getBumpLeaderboard: vi.fn(),
  getGuildStreak: vi.fn(),
  getBumpCount: vi.fn(),
  getUserStreak: vi.fn(),
  getBumpsPerDay: vi.fn(),
}));

vi.mock("../../../ai/bumpCelebrations.js", () => ({
  getBestRankInPeriod: vi.fn(),
}));

vi.mock("../../../ai/bumpUserPrefs.js", () => ({
  setUserPref: vi.fn(),
}));

vi.mock("../../../ai/bumpCorrelation.js", () => ({
  getJoinCorrelationStats: vi.fn(),
  POST_BUMP_WINDOW_MIN: 30,
}));

import { makeInteraction, makeUser, makeGuild, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as analytics from "../../../ai/bumpAnalytics.js";
import * as celebrations from "../../../ai/bumpCelebrations.js";
import * as prefs from "../../../ai/bumpUserPrefs.js";
import * as correlation from "../../../ai/bumpCorrelation.js";
import { execute } from "../../../commands/utility/bumps.js";

const A = analytics as unknown as Record<string, ReturnType<typeof vi.fn>>;
const C = celebrations as unknown as Record<string, ReturnType<typeof vi.fn>>;
const P = prefs as unknown as Record<string, ReturnType<typeof vi.fn>>;
const Co = correlation as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("bumps command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects use in DMs (no guild)", async () => {
    const interaction: any = makeInteraction({ guild: null, subcommand: "trend" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  describe("leaderboard", () => {
    it("reports when there are no bumps recorded", async () => {
      A.getBumpLeaderboard.mockResolvedValue([]);
      A.getGuildStreak.mockResolvedValue(0);
      C.getBestRankInPeriod.mockResolvedValue(null);
      const interaction: any = makeInteraction({ subcommand: "leaderboard", options: {} });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no bumps recorded yet/i);
    });

    it("ranks bumpers with medals and resolves member display names", async () => {
      A.getBumpLeaderboard.mockResolvedValue([
        { user_id: "u1", count: 10 },
        { user_id: "u2", count: 1 },
      ]);
      A.getGuildStreak.mockResolvedValue(3);
      C.getBestRankInPeriod.mockResolvedValue(2);
      const guild = makeGuild();
      guild.members.cache.set("u1", { displayName: "Alice" } as any);
      guild.members.cache.set("u2", { displayName: "Bob" } as any);
      const interaction: any = makeInteraction({
        subcommand: "leaderboard", options: { period: "7", service: "disboard" }, guild,
      });
      await execute(interaction);

      // verify it forwarded the parsed period/service to analytics.
      expect(A.getBumpLeaderboard).toHaveBeenCalledWith("guild" in interaction ? interaction.guild.id : "", {
        limit: 10, periodDays: 7, service: "disboard",
      });
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.description).toMatch(/🥇 \*\*Alice\*\* — 10 bumps/);
      expect(data.description).toMatch(/🥈 \*\*Bob\*\* — 1 bump/); // singular
      expect(data.footer.text).toMatch(/3-day streak/);
      expect(data.footer.text).toMatch(/best rank #2/);
    });
  });

  describe("me", () => {
    it("shows the caller's stats when no user option is given", async () => {
      A.getBumpCount.mockResolvedValueOnce(20).mockResolvedValueOnce(5);
      A.getUserStreak.mockResolvedValue(4);
      const interaction: any = makeInteraction({
        subcommand: "me", options: {}, user: makeUser({ id: "self", username: "me" }),
      });
      await execute(interaction);
      expect(A.getBumpCount).toHaveBeenCalledWith("self", interaction.guild.id, {});
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.title).toMatch(/me's bump stats/);
      const total = data.fields.find((f: any) => f.name === "Total bumps");
      expect(total.value).toBe("20");
    });

    it("looks up another user when the option is provided", async () => {
      A.getBumpCount.mockResolvedValue(0);
      A.getUserStreak.mockResolvedValue(0);
      const target = makeUser({ id: "other", username: "them" });
      const interaction: any = makeInteraction({ subcommand: "me", options: { user: target } });
      await execute(interaction);
      expect(A.getBumpCount).toHaveBeenCalledWith("other", interaction.guild.id, {});
    });
  });

  describe("dm", () => {
    it("saves the opt-in pref and confirms when enabled", async () => {
      P.setUserPref.mockResolvedValue({ ok: true });
      const interaction: any = makeInteraction({ subcommand: "dm", options: { enabled: true } });
      await execute(interaction);
      expect(P.setUserPref).toHaveBeenCalledWith(interaction.user.id, "personal_ping_enabled", true, "eris");
      expect(getLastReplyContent(interaction)).toMatch(/you'll get a DM/);
    });

    it("surfaces a save error", async () => {
      P.setUserPref.mockResolvedValue({ ok: false, error: "column missing" });
      const interaction: any = makeInteraction({ subcommand: "dm", options: { enabled: false } });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/couldn't save that: column missing/);
    });
  });

  describe("mvp", () => {
    it("inverts the opt-in flag to the opt-OUT storage column", async () => {
      P.setUserPref.mockResolvedValue({ ok: true });
      const interaction: any = makeInteraction({ subcommand: "mvp", options: { enabled: true } });
      await execute(interaction);
      // enabled:true -> weekly_mvp_optout:false
      expect(P.setUserPref).toHaveBeenCalledWith(interaction.user.id, "weekly_mvp_optout", false, "eris");
    });
  });

  describe("correlation", () => {
    it("reports when there is no join data", async () => {
      Co.getJoinCorrelationStats.mockResolvedValue({ totalJoins: 0 });
      const interaction: any = makeInteraction({ subcommand: "correlation" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no join data yet/i);
    });

    it("renders correlation stats with a computed percentage", async () => {
      Co.getJoinCorrelationStats.mockResolvedValue({
        totalJoins: 100, postBumpJoins: 25, postBumpRatio: 0.25, avgJoinsPerBump: 1.5,
      });
      const interaction: any = makeInteraction({ subcommand: "correlation" });
      await execute(interaction);
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.description).toMatch(/\*\*25\*\* of \*\*100\*\*/);
      expect(data.description).toMatch(/30/); // POST_BUMP_WINDOW_MIN
      expect(data.description).toMatch(/25%/);
    });
  });

  describe("trend", () => {
    it("reports when there is no trend data", async () => {
      A.getBumpsPerDay.mockResolvedValue([]);
      C.getBestRankInPeriod.mockResolvedValue(null);
      const interaction: any = makeInteraction({ subcommand: "trend" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no trend data yet/i);
    });

    it("renders a sparkline and totals for the period", async () => {
      A.getBumpsPerDay.mockResolvedValue([
        { count: 0 }, { count: 2 }, { count: 4 },
      ]);
      C.getBestRankInPeriod.mockResolvedValue(1);
      const interaction: any = makeInteraction({ subcommand: "trend" });
      await execute(interaction);
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      // total = 6, peak = 4
      expect(data.description).toMatch(/\*\*6\*\* bumps/);
      expect(data.description).toMatch(/peak \*\*4\*\*/);
      expect(data.description).toMatch(/best rank last 14d: \*\*#1\*\*/);
    });
  });
});
