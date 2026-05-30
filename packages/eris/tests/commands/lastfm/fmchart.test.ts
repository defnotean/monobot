// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTopAlbums: vi.fn(),
  getTopArtists: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));
vi.mock("../../../lastfm/chart.js", () => ({
  generateChart: vi.fn(),
}));

import * as fmchartCmd from "../../../commands/lastfm/fmchart.js";
import { getTopAlbums, getTopArtists } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { generateChart } from "../../../lastfm/chart.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

function albumList(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Album ${i}`,
    artist: { name: `Artist ${i}` },
    image: [{ size: "extralarge", "#text": `http://i/${i}.png` }],
  }));
}

describe("lastfm/fmchart command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmchart'", () => {
    expect(fmchartCmd.data?.name).toBe("fmchart");
    expect(typeof fmchartCmd.execute).toBe("function");
  });

  it("prompts to link when not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmchartCmd.execute(interaction);
    expect(getTopAlbums).not.toHaveBeenCalled();
    expect(generateChart).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("defaults to albums type, 3x3 grid (limit 9), all-time period", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue(albumList(9));
    generateChart.mockResolvedValue(Buffer.from("png"));
    const interaction = makeInteraction({ options: {} });
    await fmchartCmd.execute(interaction);
    expect(getTopAlbums).toHaveBeenCalledWith("alice", "overall", 9);
    expect(getTopArtists).not.toHaveBeenCalled();
    // size 3 -> generateChart(items, 3, false)
    const [items, size, labels] = generateChart.mock.calls[0];
    expect(items).toHaveLength(9);
    expect(size).toBe(3);
    expect(labels).toBe(false);
    const reply = getLastReply(interaction).payload;
    expect(reply.files).toHaveLength(1);
    expect(reply.embeds[0].data.author.name).toContain("3×3");
  });

  it("size N drives limit N*N and pads short results to fill grid", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    // only 2 albums returned for a 4x4 (limit 16) chart.
    getTopAlbums.mockResolvedValue(albumList(2));
    generateChart.mockResolvedValue(Buffer.from("png"));
    const interaction = makeInteraction({ options: { size: 4, labels: true } });
    await fmchartCmd.execute(interaction);
    expect(getTopAlbums).toHaveBeenCalledWith("alice", "overall", 16);
    const [items, size, labels] = generateChart.mock.calls[0];
    expect(items).toHaveLength(16); // padded
    expect(size).toBe(4);
    expect(labels).toBe(true);
    // padding entries have null image / empty label.
    expect(items[15]).toEqual({ image: null, label: "" });
  });

  it("artists type calls getTopArtists and not getTopAlbums", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopArtists.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => ({ name: `Ar ${i}`, image: [] }))
    );
    generateChart.mockResolvedValue(Buffer.from("png"));
    const interaction = makeInteraction({ options: { type: "artists" } });
    await fmchartCmd.execute(interaction);
    expect(getTopArtists).toHaveBeenCalledWith("alice", "overall", 9);
    expect(getTopAlbums).not.toHaveBeenCalled();
    expect(getLastReply(interaction).payload.embeds[0].data.author.name).toContain("top artists");
  });

  it("errors with empty data before attempting chart generation", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ options: {} });
    await fmchartCmd.execute(interaction);
    expect(generateChart).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/not enough scrobbles/);
  });

  it("surfaces API errors", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockRejectedValue(new Error("api"));
    const interaction = makeInteraction({ options: {} });
    await fmchartCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: api");
  });

  it("surfaces chart-generation failures", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getTopAlbums.mockResolvedValue(albumList(9));
    generateChart.mockRejectedValue(new Error("canvas missing"));
    const interaction = makeInteraction({ options: {} });
    await fmchartCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("chart generation failed: canvas missing");
  });
});
