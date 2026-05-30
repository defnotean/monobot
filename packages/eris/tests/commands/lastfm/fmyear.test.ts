// Tests for /fmyear — year in review
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTopArtists: vi.fn(),
  getTopAlbums: vi.fn(),
  getTopTracks: vi.fn(),
  getUserInfo: vi.fn(),
  getMonthlyScrobbleCounts: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmyear.js";
import { getTopArtists, getTopAlbums, getTopTracks, getMonthlyScrobbleCounts } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedArtists = vi.mocked(getTopArtists);
const mockedAlbums = vi.mocked(getTopAlbums);
const mockedTracks = vi.mocked(getTopTracks);
const mockedMonthly = vi.mocked(getMonthlyScrobbleCounts);
const mockedGetFmUser = vi.mocked(getFmUser);

const zeros12 = () => new Array(12).fill(0);

describe("/fmyear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the caller to link when unlinked, and never calls the API", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    expect(mockedArtists).not.toHaveBeenCalled();
    expect(mockedMonthly).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/you haven't linked/i);
  });

  it("uses the explicit year option when querying monthly counts", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedArtists.mockResolvedValue(/** @type any */([]));
    mockedAlbums.mockResolvedValue(/** @type any */([]));
    mockedTracks.mockResolvedValue(/** @type any */([]));
    mockedMonthly.mockResolvedValue(/** @type any */(zeros12()));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }), options: { year: 2021 } });

    await execute(interaction);

    expect(mockedMonthly).toHaveBeenCalledWith("alice", 2021);
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.author.name).toContain("2021");
  });

  it("survives a rejected sub-fetch via Promise.allSettled (renders with empty list)", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    // artists rejects -> allSettled maps to [] and Array.isArray guards keep it from crashing
    mockedArtists.mockRejectedValue(new Error("boom"));
    mockedAlbums.mockResolvedValue(/** @type any */([]));
    mockedTracks.mockResolvedValue(/** @type any */([]));
    const counts = zeros12();
    counts[4] = 300; // May peak
    mockedMonthly.mockResolvedValue(/** @type any */(counts));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }), options: { year: 2023 } });

    await execute(interaction);

    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    // yearTotal 300 and peak month May surfaced in description
    expect(embed.description).toContain("300");
    expect(embed.description).toMatch(/peak month:\s*\*\*May\*\*/);
  });

  it("adds top-artist/album/track fields when data is present", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedArtists.mockResolvedValue(/** @type any */([{ name: "Radiohead", playcount: "1000" }]));
    mockedAlbums.mockResolvedValue(/** @type any */([{ name: "OK Computer", artist: { name: "Radiohead" }, playcount: "500", image: [{ size: "extralarge", "#text": "http://a.png" }] }]));
    mockedTracks.mockResolvedValue(/** @type any */([{ name: "Creep", artist: { name: "Radiohead" }, playcount: "250" }]));
    mockedMonthly.mockResolvedValue(/** @type any */(zeros12()));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }), options: { year: 2024 } });

    await execute(interaction);

    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames.some((n) => /Top Artists/i.test(n))).toBe(true);
    expect(fieldNames.some((n) => /Top Albums/i.test(n))).toBe(true);
    expect(fieldNames.some((n) => /Top Tracks/i.test(n))).toBe(true);
    // album art thumbnail set from the first album
    expect(embed.thumbnail.url).toBe("http://a.png");
  });
});
