// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/db.js", () => ({
  getUserCrowns: vi.fn(),
  getGuildCrownsLeaderboard: vi.fn(),
  getFmUser: vi.fn(),
}));

import * as fmcrownsCmd from "../../../commands/lastfm/fmcrowns.js";
import { getUserCrowns, getGuildCrownsLeaderboard, getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

describe("lastfm/fmcrowns command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmcrowns'", () => {
    expect(fmcrownsCmd.data?.name).toBe("fmcrowns");
    expect(typeof fmcrownsCmd.execute).toBe("function");
  });

  it("refuses in DMs (no guild) before deferring", async () => {
    const interaction = makeInteraction({ guild: null, subcommand: "user", options: {} });
    await fmcrownsCmd.execute(interaction);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toBe("this command only works in servers");
    const reply = getLastReply(interaction);
    expect(reply.payload.ephemeral).toBe(true);
  });

  // ── server subcommand ──
  it("server: reports empty leaderboard", async () => {
    getGuildCrownsLeaderboard.mockResolvedValue([]);
    const guild = makeGuild({ memberCount: 1, members: [] });
    const interaction = makeInteraction({ guild, subcommand: "server", options: {} });
    await fmcrownsCmd.execute(interaction);
    expect(getGuildCrownsLeaderboard).toHaveBeenCalledWith(guild.id);
    expect(getLastReplyContent(interaction)).toMatch(/no crowns in this server yet/);
  });

  it("server: renders leaderboard resolving displayNames and pluralizing", async () => {
    getGuildCrownsLeaderboard.mockResolvedValue([
      { discord_id: "u1", crown_count: 3 },
      { discord_id: "u2", crown_count: 1 },
    ]);
    const m1 = makeMember({ id: "u1", user: makeUser({ id: "u1", username: "alice" }), displayName: "Alice" });
    const guild = makeGuild({ memberCount: 2, members: [m1] });
    const interaction = makeInteraction({ guild, subcommand: "server", options: {} });
    await fmcrownsCmd.execute(interaction);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.title).toContain("Crown Leaderboard");
    expect(embed.description).toContain("Alice");
    expect(embed.description).toContain("3 crowns"); // plural
    expect(embed.description).toContain("1 crown"); // singular, falls back to id u2
    expect(embed.description).toContain("u2");
    expect(embed.footer.text).toBe("2 crown holders total");
  });

  // ── user subcommand ──
  it("user: prompts to link when target not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const guild = makeGuild();
    const interaction = makeInteraction({ guild, subcommand: "user", options: {} });
    await fmcrownsCmd.execute(interaction);
    expect(getUserCrowns).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("user: reports no crowns for self", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getUserCrowns.mockResolvedValue([]);
    const guild = makeGuild();
    const interaction = makeInteraction({ guild, subcommand: "user", options: {} });
    await fmcrownsCmd.execute(interaction);
    expect(getUserCrowns).toHaveBeenCalledWith(guild.id, interaction.user.id);
    expect(getLastReplyContent(interaction)).toMatch(/don't have any crowns yet/);
  });

  it("user: renders crown list with formatted plays", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getUserCrowns.mockResolvedValue([
      { artist_name: "Radiohead", play_count: "1234" },
      { artist_name: "Bjork", play_count: "10" },
    ]);
    const guild = makeGuild();
    const interaction = makeInteraction({ guild, subcommand: "user", options: {} });
    await fmcrownsCmd.execute(interaction);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toContain("alice's crowns");
    expect(embed.description).toContain("Radiohead");
    expect(embed.description).toContain("1,234 plays");
    expect(embed.footer.text).toContain("2 crowns");
  });
});
