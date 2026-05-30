// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getUserInfo: vi.fn(),
  getTopArtists: vi.fn(),
  getTopAlbums: vi.fn(),
  getArtistInfo: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import * as fmprofileCmd from "../../../commands/lastfm/fmprofile.js";
import { getUserInfo, getTopArtists, getTopAlbums, getArtistInfo } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const USER_INFO = {
  playcount: "50000",
  artist_count: "800",
  album_count: "1200",
  track_count: "6000",
  image: [{ size: "extralarge", "#text": "http://avatar.png" }],
  registered: { unixtime: "1277942400" }, // 2010-07-01 (mid-year, tz-safe)
};

describe("lastfm/fmprofile command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmprofile'", () => {
    expect(fmprofileCmd.data?.name).toBe("fmprofile");
    expect(typeof fmprofileCmd.execute).toBe("function");
  });

  it("prompts to link when not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmprofileCmd.execute(interaction);
    expect(getUserInfo).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("surfaces a core-data API error", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getUserInfo.mockRejectedValue(new Error("502"));
    getTopArtists.mockResolvedValue([]);
    getTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ options: {} });
    await fmprofileCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: 502");
  });

  it("derives weighted top genres, skips junk tags, and renders the embed", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getUserInfo.mockResolvedValue(USER_INFO);
    getTopArtists.mockResolvedValue([
      { name: "Big", playcount: "1000" },
      { name: "Mid", playcount: "100" },
      { name: "Low", playcount: "10" },
    ]);
    getTopAlbums.mockResolvedValue([{ name: "Al", image: [] }]);
    // artist tag info: "rock" should win (weighted by highest plays).
    getArtistInfo.mockImplementation(async (name) => {
      if (name === "Big") return { tags: { tag: [{ name: "rock" }, { name: "love" /*junk*/ }] } };
      if (name === "Mid") return { tags: { tag: [{ name: "jazz" }] } };
      return { tags: { tag: [{ name: "rock" }] } };
    });
    const interaction = makeInteraction({ options: {} });
    await fmprofileCmd.execute(interaction);

    expect(getTopArtists).toHaveBeenCalledWith("alice", "overall", 5);
    expect(getTopAlbums).toHaveBeenCalledWith("alice", "overall", 1);

    const embed = getLastReply(interaction).payload.embeds[0].data;
    const scrobblesField = embed.fields.find(f => f.name === "Scrobbles").value;
    expect(scrobblesField).toContain("50,000");
    expect(scrobblesField).toContain("800 artists");

    const genres = embed.fields.find(f => f.name === "Top Genres");
    expect(genres).toBeDefined();
    // rock got weight 1000+10 -> first; junk "love" excluded.
    expect(genres.value.startsWith("rock")).toBe(true);
    expect(genres.value).not.toContain("love");
    expect(genres.value).toContain("jazz");

    // registered year footer.
    expect(embed.footer.text).toMatch(/member since 2010/);
    // top artists list uses medals.
    expect(embed.fields.find(f => f.name === "Top Artists (All Time)").value).toContain("Big");
  });

  it("omits genres field when genre derivation yields nothing", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getUserInfo.mockResolvedValue({ ...USER_INFO, registered: null });
    getTopArtists.mockResolvedValue([{ name: "Big", playcount: "1000" }]);
    getTopAlbums.mockResolvedValue([]);
    getArtistInfo.mockRejectedValue(new Error("no tags")); // all settle rejected
    const interaction = makeInteraction({ options: {} });
    await fmprofileCmd.execute(interaction);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.fields.find(f => f.name === "Top Genres")).toBeUndefined();
    expect(embed.footer).toBeUndefined(); // no registered date
  });
});
