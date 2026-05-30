// Tests for /fmtrack — track info (defaults to now playing)
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTrackInfo: vi.fn(),
  getNowPlaying: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmtrack.js";
import { getTrackInfo, getNowPlaying } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedTrackInfo = vi.mocked(getTrackInfo);
const mockedNowPlaying = vi.mocked(getNowPlaying);
const mockedGetFmUser = vi.mocked(getFmUser);

describe("/fmtrack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for input when no track is given and the user is unlinked", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));
    const interaction = makeInteraction({
      user: makeUser({ id: "me" }),
      options: { artist: null, track: null },
    });

    await execute(interaction);

    expect(mockedNowPlaying).not.toHaveBeenCalled();
    expect(mockedTrackInfo).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/provide an artist and track/i);
  });

  it("falls back to now-playing when only a linked account is available", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedNowPlaying.mockResolvedValue(/** @type any */({
      track: { name: "Karma Police", artist: { "#text": "Radiohead" } },
    }));
    mockedTrackInfo.mockResolvedValue(/** @type any */({
      name: "Karma Police",
      artist: { name: "Radiohead" },
      listeners: "5000",
      playcount: "100000",
    }));
    const interaction = makeInteraction({
      user: makeUser({ id: "me" }),
      options: { artist: null, track: null },
    });

    await execute(interaction);

    // resolved artist/track from now playing fed into getTrackInfo with the linked user
    expect(mockedTrackInfo).toHaveBeenCalledWith("Radiohead", "Karma Police", "alice");
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.author.name).toContain("Karma Police");
  });

  it("reports nothing playing when fallback finds no track", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedNowPlaying.mockResolvedValue(/** @type any */({ track: null }));
    const interaction = makeInteraction({
      user: makeUser({ id: "me" }),
      options: { artist: null, track: null },
    });

    await execute(interaction);

    expect(mockedTrackInfo).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/nothing currently playing/i);
  });

  it("shows a not-found message for an unknown track (err.code 6)", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));
    mockedTrackInfo.mockRejectedValue(Object.assign(new Error("nope"), { code: 6 }));
    const interaction = makeInteraction({
      user: makeUser({ id: "me" }),
      options: { artist: "Ghost", track: "Nonexistent" },
    });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/couldn't find \*\*Nonexistent\*\* by \*\*Ghost\*\*/i);
  });

  it("includes the user's play count field only when both userplaycount and a linked user exist", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedTrackInfo.mockResolvedValue(/** @type any */({
      name: "Idioteque",
      artist: { name: "Radiohead" },
      listeners: "1000",
      playcount: "9000",
      userplaycount: "42",
      duration: "183000",
      toptags: { tag: [{ name: "electronic" }] },
    }));
    const interaction = makeInteraction({
      user: makeUser({ id: "me" }),
      options: { artist: "Radiohead", track: "Idioteque" },
    });

    await execute(interaction);

    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toContain("alice's plays");
    expect(fieldNames).toContain("Duration");
    // 183000ms -> 3:03
    const dur = embed.fields.find((f) => f.name === "Duration");
    expect(dur.value).toBe("3:03");
  });
});
