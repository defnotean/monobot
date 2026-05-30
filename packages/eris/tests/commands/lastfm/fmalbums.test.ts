// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTopAlbums: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import * as fmalbumsCmd from "../../../commands/lastfm/fmalbums.js";
import { getTopAlbums } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

describe("lastfm/fmalbums command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmalbums'", () => {
    expect(fmalbumsCmd.data?.name).toBe("fmalbums");
    expect(typeof fmalbumsCmd.execute).toBe("function");
  });

  it("prompts to link when not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmalbumsCmd.execute(interaction);
    expect(getTopAlbums).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("maps the chosen period key to its api value and the count limit", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue([
      { name: "Al", artist: { name: "Ar" }, playcount: "9", image: [] },
    ]);
    const interaction = makeInteraction({ options: { period: "7d", count: 5 } });
    await fmalbumsCmd.execute(interaction);
    // periodApi("7d") -> "7day", limit -> 5
    expect(getTopAlbums).toHaveBeenCalledWith("alice", "7day", 5);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toContain("Last 7 Days");
  });

  it("an unknown period falls back to overall / All Time", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue([
      { name: "Al", artist: { name: "Ar" }, playcount: "9", image: [] },
    ]);
    const interaction = makeInteraction({ options: { period: "bogus" } });
    await fmalbumsCmd.execute(interaction);
    // periodApi falls back to "overall" for unrecognised keys.
    expect(getTopAlbums).toHaveBeenCalledWith("alice", "overall", 10);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toContain("All Time");
  });

  it("defaults period to all (overall) and count to 10", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue([
      { name: "Al", artist: { name: "Ar" }, playcount: "9", image: [] },
    ]);
    const interaction = makeInteraction({ options: {} });
    await fmalbumsCmd.execute(interaction);
    expect(getTopAlbums).toHaveBeenCalledWith("alice", "overall", 10);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toContain("All Time");
  });

  it("reports an empty period", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ options: {} });
    await fmalbumsCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("no scrobbles found for that period");
  });

  it("surfaces API errors", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockRejectedValue(new Error("down"));
    const interaction = makeInteraction({ options: {} });
    await fmalbumsCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: down");
  });

  it("numbers each album line with plays", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue([
      { name: "First", artist: { name: "A1" }, playcount: "100", image: [] },
      { name: "Second", artist: { name: "A2" }, playcount: "50", image: [] },
    ]);
    const interaction = makeInteraction({ options: {} });
    await fmalbumsCmd.execute(interaction);
    const desc = getLastReply(interaction).payload.embeds[0].data.description;
    expect(desc).toContain("First");
    expect(desc).toContain("by A1");
    expect(desc).toContain("100 plays");
    expect(desc.split("\n")).toHaveLength(2);
  });

  it("uses another member's username in the not-linked message", async () => {
    getFmUser.mockResolvedValue(null);
    const other = makeUser({ id: "z", username: "zed" });
    const interaction = makeInteraction({ options: { user: other } });
    await fmalbumsCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("zed hasn't linked their last.fm");
  });
});
