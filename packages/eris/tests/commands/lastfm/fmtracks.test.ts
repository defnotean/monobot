// Tests for /fmtracks — top tracks for a time period
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTopTracks: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmtracks.js";
import { getTopTracks } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedTopTracks = vi.mocked(getTopTracks);
const mockedGetFmUser = vi.mocked(getFmUser);

describe("/fmtracks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the caller to link when unlinked", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    expect(mockedTopTracks).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/you haven't linked/i);
  });

  it("maps the 'all' period to the overall API value and uses default count", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedTopTracks.mockResolvedValue(/** @type any */([
      { name: "Creep", artist: { name: "Radiohead" }, playcount: "12000", image: [] },
    ]));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    // periodApi("all") -> "overall"; default limit 10
    expect(mockedTopTracks).toHaveBeenCalledWith("alice", "overall", 10);
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.description).toContain("Creep");
    expect(embed.description).toContain("12,000");
  });

  it("passes through an explicit period + count", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedTopTracks.mockResolvedValue(/** @type any */([
      { name: "Creep", artist: { name: "Radiohead" }, playcount: "1", image: [] },
    ]));
    // "7d" is a real PERIOD_CHOICES value; periodApi maps it to the API's "7day".
    const interaction = makeInteraction({ user: makeUser({ id: "me" }), options: { period: "7d", count: 5 } });

    await execute(interaction);

    expect(mockedTopTracks).toHaveBeenCalledWith("alice", "7day", 5);
  });

  it("reports empty results for a period with no scrobbles", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedTopTracks.mockResolvedValue(/** @type any */([]));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/no scrobbles found/i);
  });

  it("surfaces API errors", async () => {
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedTopTracks.mockRejectedValue(new Error("503"));
    const interaction = makeInteraction({ user: makeUser({ id: "me" }) });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/last\.fm error: 503/i);
  });
});
