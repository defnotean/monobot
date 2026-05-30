// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getAlbumInfo: vi.fn(),
  getNowPlaying: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import * as fmalbumCmd from "../../../commands/lastfm/fmalbum.js";
import { getAlbumInfo, getNowPlaying } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const ALBUM = {
  name: "Album",
  artist: "Artist",
  image: [{ size: "extralarge", "#text": "http://i/a.png" }],
  listeners: "1000",
  playcount: "5000",
  userplaycount: "12",
  tracks: { track: [{ name: "t1" }, { name: "t2" }] },
  tags: { tag: [{ name: "rock" }, { name: "indie" }] },
  wiki: { summary: "A great <b>album</b>. <a href='x'>read more</a>" },
};

describe("lastfm/fmalbum command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmalbum'", () => {
    expect(fmalbumCmd.data?.name).toBe("fmalbum");
    expect(typeof fmalbumCmd.execute).toBe("function");
  });

  it("asks for manual input when no args and no linked account", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmalbumCmd.execute(interaction);
    expect(getNowPlaying).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/provide an artist and album/);
  });

  it("falls back to currently-playing track to fill artist+album", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getNowPlaying.mockResolvedValue({
      track: { artist: { "#text": "Artist" }, album: { "#text": "Album" } },
    });
    getAlbumInfo.mockResolvedValue(ALBUM);
    const interaction = makeInteraction({ options: {} });
    await fmalbumCmd.execute(interaction);
    expect(getNowPlaying).toHaveBeenCalledWith("alice");
    expect(getAlbumInfo).toHaveBeenCalledWith("Artist", "Album", "alice");
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toBe("Album — Artist");
  });

  it("errors when current track has no album to detect", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getNowPlaying.mockResolvedValue({ track: { artist: { "#text": "Artist" } } });
    const interaction = makeInteraction({ options: {} });
    await fmalbumCmd.execute(interaction);
    expect(getAlbumInfo).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/couldn't detect album/);
  });

  it("reports not-found on error code 6", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    const err = new Error("not found"); err.code = 6;
    getAlbumInfo.mockRejectedValue(err);
    const interaction = makeInteraction({ options: { artist: "X", album: "Y" } });
    await fmalbumCmd.execute(interaction);
    expect(getNowPlaying).not.toHaveBeenCalled(); // both inputs supplied, no NP lookup
    expect(getLastReplyContent(interaction)).toBe("couldn't find **Y** by **X**");
  });

  it("surfaces generic API errors", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getAlbumInfo.mockRejectedValue(new Error("boom"));
    const interaction = makeInteraction({ options: { artist: "X", album: "Y" } });
    await fmalbumCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: boom");
  });

  it("builds a rich embed with stats, user plays, track count, tags, and stripped bio", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getAlbumInfo.mockResolvedValue(ALBUM);
    const interaction = makeInteraction({ options: { artist: "Artist", album: "Album" } });
    await fmalbumCmd.execute(interaction);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    const fields = embed.fields;
    expect(fields.find(f => f.name === "Listeners").value).toBe("1,000");
    expect(fields.find(f => f.name === "Scrobbles").value).toBe("5,000");
    expect(fields.find(f => f.name === "alice's plays").value).toBe("12");
    expect(fields.find(f => f.name === "Tracks").value).toBe("2");
    expect(fields.find(f => f.name === "Tags").value).toBe("rock, indie");
    // bio HTML tags stripped (no angle brackets survive); stripHtml unwraps
    // <a>…</a> into its inner text, so the link label is preserved as plain text.
    expect(embed.description).toContain("A great album");
    expect(embed.description).not.toContain("<");
    expect(embed.description).toContain("read more");
  });
});
