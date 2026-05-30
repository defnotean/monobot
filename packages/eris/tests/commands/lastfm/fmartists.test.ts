// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTopArtists: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import * as fmartistsCmd from "../../../commands/lastfm/fmartists.js";
import { getTopArtists } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

describe("lastfm/fmartists command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmartists'", () => {
    expect(fmartistsCmd.data?.name).toBe("fmartists");
    expect(typeof fmartistsCmd.execute).toBe("function");
  });

  it("prompts to link when not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmartistsCmd.execute(interaction);
    expect(getTopArtists).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("translates period key 1y -> api 12month, label 'Last Year'", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopArtists.mockResolvedValue([{ name: "A", playcount: "3" }]);
    const interaction = makeInteraction({ options: { period: "1y", count: 25 } });
    await fmartistsCmd.execute(interaction);
    expect(getTopArtists).toHaveBeenCalledWith("alice", "12month", 25);
    expect(getLastReply(interaction).payload.embeds[0].data.author.name).toContain("Last Year");
  });

  it("reports empty period", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopArtists.mockResolvedValue([]);
    const interaction = makeInteraction({ options: {} });
    await fmartistsCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("no scrobbles found for that period");
  });

  it("surfaces API errors", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopArtists.mockRejectedValue(new Error("err"));
    const interaction = makeInteraction({ options: {} });
    await fmartistsCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: err");
  });

  it("renders each artist line with formatted plays", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopArtists.mockResolvedValue([
      { name: "Big Band", playcount: "12345" },
      { name: "Small Band", playcount: "1" },
    ]);
    const interaction = makeInteraction({ options: {} });
    await fmartistsCmd.execute(interaction);
    const desc = getLastReply(interaction).payload.embeds[0].data.description;
    expect(desc).toContain("Big Band");
    expect(desc).toContain("12,345 plays");
    expect(desc.split("\n")).toHaveLength(2);
  });
});
