// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTagTopArtists: vi.fn(),
  getTagTopAlbums: vi.fn(),
  getTagInfo: vi.fn(),
}));

import * as fmgenreCmd from "../../../commands/lastfm/fmgenre.js";
import { getTagTopArtists, getTagTopAlbums, getTagInfo } from "../../../lastfm/api.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

describe("lastfm/fmgenre command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmgenre'", () => {
    expect(fmgenreCmd.data?.name).toBe("fmgenre");
    expect(typeof fmgenreCmd.execute).toBe("function");
  });

  it("trims the genre and defaults type to artists", async () => {
    getTagTopArtists.mockResolvedValue([{ name: "A" }, { name: "B" }]);
    getTagInfo.mockResolvedValue({ name: "jazz", total: "12345" });
    const interaction = makeInteraction({ options: { genre: "  jazz  " } });
    await fmgenreCmd.execute(interaction);
    expect(getTagTopArtists).toHaveBeenCalledWith("jazz", 10);
    expect(getTagTopAlbums).not.toHaveBeenCalled();
    expect(getTagInfo).toHaveBeenCalledWith("jazz");
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.title).toBe('Top artists tagged "jazz"');
    expect(embed.footer.text).toBe("12,345 taggings");
  });

  it("type albums routes to getTagTopAlbums and lists artist names", async () => {
    getTagTopAlbums.mockResolvedValue([{ name: "Album", artist: { name: "Band" } }]);
    getTagInfo.mockResolvedValue({ name: "metal" });
    const interaction = makeInteraction({ options: { genre: "metal", type: "albums" } });
    await fmgenreCmd.execute(interaction);
    expect(getTagTopAlbums).toHaveBeenCalledWith("metal", 10);
    expect(getTagTopArtists).not.toHaveBeenCalled();
    const desc = getLastReply(interaction).payload.embeds[0].data.description;
    expect(desc).toContain("Album");
    expect(desc).toContain("by Band");
  });

  it("survives a failing getTagInfo via allSettled (uses raw genre as name)", async () => {
    getTagTopArtists.mockResolvedValue([{ name: "A" }]);
    getTagInfo.mockRejectedValue(new Error("tag info down"));
    const interaction = makeInteraction({ options: { genre: "shoegaze" } });
    await fmgenreCmd.execute(interaction);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.title).toBe('Top artists tagged "shoegaze"');
    // no tagInfo -> no footer
    expect(embed.footer).toBeUndefined();
  });

  it("reports no results when the items list is empty", async () => {
    getTagTopArtists.mockResolvedValue([]);
    getTagInfo.mockResolvedValue(null);
    const interaction = makeInteraction({ options: { genre: "obscure" } });
    await fmgenreCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("couldn't find any artists for the tag **obscure**");
  });

  it("reports no results when the items lookup itself rejected (null from allSettled)", async () => {
    getTagTopArtists.mockRejectedValue(new Error("boom"));
    getTagInfo.mockResolvedValue({ name: "x" });
    const interaction = makeInteraction({ options: { genre: "x" } });
    await fmgenreCmd.execute(interaction);
    // allSettled makes items null -> the not-found branch, NOT the catch.
    expect(getLastReplyContent(interaction)).toBe("couldn't find any artists for the tag **x**");
  });

  it("adds an About field from a stripped tag wiki summary", async () => {
    getTagTopArtists.mockResolvedValue([{ name: "A" }]);
    getTagInfo.mockResolvedValue({
      name: "jazz",
      wiki: { summary: "Jazz is a <b>genre</b>. <a href='z'>more</a>" },
    });
    const interaction = makeInteraction({ options: { genre: "jazz" } });
    await fmgenreCmd.execute(interaction);
    const fields = getLastReply(interaction).payload.embeds[0].data.fields;
    const about = fields.find(f => f.name === "About");
    // HTML tags removed (no angle brackets); stripHtml unwraps the <a> label,
    // so "more" survives as plain text.
    expect(about.value).toContain("Jazz is a genre");
    expect(about.value).not.toContain("<");
    expect(about.value).toContain("more");
  });
});
