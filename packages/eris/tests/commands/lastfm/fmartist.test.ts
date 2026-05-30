// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getArtistInfo: vi.fn(),
  getArtistTopAlbums: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import * as fmartistCmd from "../../../commands/lastfm/fmartist.js";
import { getArtistInfo, getArtistTopAlbums } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeOptions, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const INFO = {
  name: "Radiohead",
  bio: { summary: "An English <i>rock</i> band. <a href='y'>more</a>" },
  stats: { listeners: "2000000", playcount: "9000000", userplaycount: "321" },
  tags: { tag: [{ name: "alternative" }, { name: "rock" }] },
};

describe("lastfm/fmartist command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmartist'", () => {
    expect(fmartistCmd.data?.name).toBe("fmartist");
    expect(typeof fmartistCmd.execute).toBe("function");
  });

  it("passes the artist arg and linked username to the API in parallel", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getArtistInfo.mockResolvedValue(INFO);
    getArtistTopAlbums.mockResolvedValue([{ name: "OK Computer" }, { name: "Kid A" }]);
    const interaction = makeInteraction({ options: { artist: "Radiohead" } });
    await fmartistCmd.execute(interaction);
    expect(getArtistInfo).toHaveBeenCalledWith("Radiohead", "alice");
    expect(getArtistTopAlbums).toHaveBeenCalledWith("Radiohead", 3);
  });

  it("works with no linked account (lfmUser null, user plays omitted)", async () => {
    getFmUser.mockResolvedValue(null);
    getArtistInfo.mockResolvedValue({ ...INFO, stats: { listeners: "1", playcount: "2", userplaycount: "5" } });
    getArtistTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ options: { artist: "Radiohead" } });
    await fmartistCmd.execute(interaction);
    expect(getArtistInfo).toHaveBeenCalledWith("Radiohead", null);
    const fields = getLastReply(interaction).payload.embeds[0].data.fields;
    // userplaycount present but no lfmUser -> the "plays" field must be suppressed.
    expect(fields.find(f => /plays$/.test(f.name))).toBeUndefined();
  });

  it("reports not-found for error code 6", async () => {
    getFmUser.mockResolvedValue(null);
    const err = new Error("nope"); err.code = 6;
    getArtistInfo.mockRejectedValue(err);
    getArtistTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ options: { artist: "Nobody" } });
    await fmartistCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("couldn't find an artist named **Nobody**");
  });

  it("surfaces generic errors", async () => {
    getFmUser.mockResolvedValue(null);
    getArtistInfo.mockRejectedValue(new Error("teapot"));
    getArtistTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ options: { artist: "X" } });
    await fmartistCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: teapot");
  });

  it("builds embed with stats, user plays, tags, top albums and stripped bio", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getArtistInfo.mockResolvedValue(INFO);
    getArtistTopAlbums.mockResolvedValue([{ name: "OK Computer" }, { name: "Kid A" }]);
    const interaction = makeInteraction({ options: { artist: "Radiohead" } });
    await fmartistCmd.execute(interaction);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toBe("Radiohead");
    const fields = embed.fields;
    expect(fields.find(f => f.name === "Listeners").value).toBe("2,000,000");
    expect(fields.find(f => f.name === "alice's plays").value).toBe("321");
    expect(fields.find(f => f.name === "Tags").value).toBe("alternative, rock");
    const albums = fields.find(f => f.name === "Top Albums").value;
    expect(albums).toContain("1. OK Computer");
    expect(albums).toContain("2. Kid A");
    expect(embed.description).toContain("An English rock band");
    expect(embed.description).not.toContain("<");
  });
});
