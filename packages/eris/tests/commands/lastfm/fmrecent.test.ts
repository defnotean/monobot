// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getRecentTracks: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import * as fmrecentCmd from "../../../commands/lastfm/fmrecent.js";
import { getRecentTracks } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

describe("lastfm/fmrecent command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmrecent'", () => {
    expect(fmrecentCmd.data?.name).toBe("fmrecent");
    expect(typeof fmrecentCmd.execute).toBe("function");
  });

  it("prompts to link when not linked", async () => {
    getFmUser.mockResolvedValue(null);
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    expect(getRecentTracks).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/haven't linked your last\.fm/);
  });

  it("defaults the count to 10", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockResolvedValue({ track: [{ name: "T", artist: { "#text": "A" }, image: [], date: { uts: "1" } }] });
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    expect(getRecentTracks).toHaveBeenCalledWith("alice", 10);
  });

  it("honors an explicit count", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockResolvedValue({ track: [{ name: "T", artist: { "#text": "A" }, image: [] }] });
    const interaction = makeInteraction({ options: { count: 3 } });
    await fmrecentCmd.execute(interaction);
    expect(getRecentTracks).toHaveBeenCalledWith("alice", 3);
  });

  it("reports empty scrobbles when track list is empty", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockResolvedValue({ track: [] });
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("alice hasn't scrobbled anything yet");
  });

  it("reports empty scrobbles when track is missing entirely", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockResolvedValue({});
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("alice hasn't scrobbled anything yet");
  });

  it("surfaces API errors", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockRejectedValue(new Error("nope"));
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("last.fm error: nope");
  });

  it("normalizes a single (non-array) track and flags now-playing", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockResolvedValue({
      track: { name: "Live Song", artist: { "#text": "Band" }, image: [], "@attr": { nowplaying: "true" } },
    });
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    const desc = getLastReply(interaction).payload.embeds[0].data.description;
    expect(desc).toContain("Live Song");
    expect(desc).toContain("Band");
    expect(desc).toContain("now"); // now-playing marker
  });

  it("renders multiple recent tracks numbered, with relative time", async () => {
    getFmUser.mockResolvedValue({ lastfm_username: "alice" });
    getRecentTracks.mockResolvedValue({
      track: [
        { name: "One", artist: { "#text": "A1" }, image: [], date: { uts: String(Math.floor(Date.now() / 1000) - 120) } },
        { name: "Two", artist: { name: "A2" }, image: [] },
      ],
    });
    const interaction = makeInteraction({ options: {} });
    await fmrecentCmd.execute(interaction);
    const desc = getLastReply(interaction).payload.embeds[0].data.description;
    expect(desc.split("\n")).toHaveLength(2);
    expect(desc).toContain("One");
    expect(desc).toContain("Two");
    expect(desc).toMatch(/m ago/);
  });
});
