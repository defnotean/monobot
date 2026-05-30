// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getNowPlaying: vi.fn(),
  getAllTopArtists: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
  indexUserArtists: vi.fn(),
}));

import * as fmCmd from "../../../commands/lastfm/fm.js";
import { getNowPlaying, getAllTopArtists } from "../../../lastfm/api.js";
import { getFmUser, indexUserArtists } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

describe("lastfm/fm command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fm' and an execute fn", () => {
    expect(fmCmd.data?.name).toBe("fm");
    expect(typeof fmCmd.execute).toBe("function");
  });

  it("defers, then prompts self to link when not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmCmd.execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(getNowPlaying).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("tells you another user hasn't linked (uses target username, not self copy)", async () => {
    getFmUser.mockResolvedValue(null);
    const other = makeUser({ id: "other-99", username: "bob" });
    const interaction = makeInteraction({ options: { user: other } });
    await fmCmd.execute(interaction);
    const content = getLastReplyContent(interaction);
    expect(content).toContain("bob");
    expect(content).not.toMatch(/use `\/fmset/);
  });

  it("surfaces a last.fm API error via editReply", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getNowPlaying.mockRejectedValue(new Error("rate limited"));
    const interaction = makeInteraction({ options: {} });
    await fmCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: rate limited");
  });

  it("reports empty scrobbles when no track", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getNowPlaying.mockResolvedValue({ track: null, isNowPlaying: false });
    const interaction = makeInteraction({ options: {} });
    await fmCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("alice hasn't scrobbled anything yet");
  });

  it("builds a now-playing embed and background-indexes own artists", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getNowPlaying.mockResolvedValue({
      isNowPlaying: true,
      track: {
        name: "Song",
        artist: { "#text": "The Band" },
        album: { "#text": "Album X" },
        image: [{ size: "extralarge", "#text": "http://img/x.png" }],
        userplaycount: "5",
      },
    });
    getAllTopArtists.mockResolvedValue([{ name: "The Band", playcount: 5 }]);
    indexUserArtists.mockResolvedValue(undefined);

    const interaction = makeInteraction({ options: {} });
    await fmCmd.execute(interaction);

    const reply = getLastReply(interaction);
    const embed = reply.payload.embeds[0].data;
    expect(embed.title).toBe("Song");
    expect(embed.author.name).toContain("is listening to");
    expect(embed.description).toContain("The Band");
    expect(embed.description).toContain("Album X");
    // userplaycount present -> footer; nowPlaying -> no timestamp.
    expect(embed.footer.text).toContain("5 plays");
    // background indexing fires for self.
    await new Promise(r => setTimeout(r, 0));
    expect(getAllTopArtists).toHaveBeenCalledWith("alice", 200);
  });

  it("does NOT background-index when viewing another user", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "carol" });
    getNowPlaying.mockResolvedValue({
      isNowPlaying: false,
      track: { name: "T", artist: { name: "A" }, image: [], date: { uts: "1" } },
    });
    const other = makeUser({ id: "viewed-1", username: "carolyn" });
    const interaction = makeInteraction({ options: { user: other } });
    await fmCmd.execute(interaction);
    await new Promise(r => setTimeout(r, 0));
    expect(getAllTopArtists).not.toHaveBeenCalled();
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.author.name).toContain("last listened to");
  });
});
