// Tests for /fmwhoknowstrack — who in this server has listened to a track
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTrackInfo: vi.fn(),
  getNowPlaying: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getGuildWhoKnowsTrack: vi.fn(),
  getLinkedMembers: vi.fn(),
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmwhoknowstrack.js";
import { getTrackInfo, getNowPlaying } from "../../../lastfm/api.js";
import { getGuildWhoKnowsTrack, getLinkedMembers, getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedTrackInfo = vi.mocked(getTrackInfo);
const mockedNowPlaying = vi.mocked(getNowPlaying);
const mockedWhoKnows = vi.mocked(getGuildWhoKnowsTrack);
const mockedLinked = vi.mocked(getLinkedMembers);
const mockedGetFmUser = vi.mocked(getFmUser);

function fullGuild(members) {
  return makeGuild({ members, memberCount: members.length });
}

describe("/fmwhoknowstrack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to run outside a guild", async () => {
    const interaction = makeInteraction({ guild: null, options: { track: "Creep", artist: "Radiohead" } });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  it("with no track and unlinked caller, asks for a track name", async () => {
    const guild = fullGuild([makeMember({ id: "me", user: makeUser({ id: "me" }) })]);
    const interaction = makeInteraction({ guild, user: makeUser({ id: "me" }), options: { track: null, artist: null } });
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));

    await execute(interaction);

    expect(mockedNowPlaying).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/provide a track name/i);
  });

  it("requires an artist when a track is supplied without one", async () => {
    const guild = fullGuild([makeMember({ id: "me", user: makeUser({ id: "me" }) })]);
    const interaction = makeInteraction({ guild, options: { track: "Creep", artist: null } });

    await execute(interaction);

    expect(mockedTrackInfo).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/provide an artist name/i);
  });

  it("falls back to now playing when track omitted and caller linked", async () => {
    const guild = fullGuild([makeMember({ id: "me", user: makeUser({ id: "me" }) })]);
    const interaction = makeInteraction({ guild, user: makeUser({ id: "me" }), options: { track: null, artist: null } });
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedNowPlaying.mockResolvedValue(/** @type any */({
      track: { name: "Creep", artist: { "#text": "Radiohead" } },
    }));
    mockedTrackInfo.mockResolvedValue(/** @type any */({ name: "Creep", artist: { name: "Radiohead" } }));
    mockedLinked.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    expect(mockedNowPlaying).toHaveBeenCalledWith("alice");
    expect(getLastReplyContent(interaction)).toMatch(/nobody.*linked/i);
  });

  it("renders the leaderboard with resolved names and aggregate footer", async () => {
    const m1 = makeMember({ id: "u1", user: makeUser({ id: "u1" }) });
    m1.displayName = "Alice";
    const guild = fullGuild([m1]);
    const interaction = makeInteraction({ guild, options: { track: "creep", artist: "radiohead" } });

    mockedTrackInfo.mockResolvedValue(/** @type any */({ name: "Creep", artist: { name: "Radiohead" } }));
    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "u1", lastfm_username: "alice" }]));
    mockedWhoKnows.mockResolvedValue(/** @type any */([{ discord_id: "u1", play_count: 77 }]));

    await execute(interaction);

    expect(mockedWhoKnows).toHaveBeenCalledWith(["u1"], "Radiohead", "Creep");
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.author.name).toContain("Creep");
    expect(embed.description).toContain("Alice");
    expect(embed.description).toContain("77");
    expect(embed.footer.text).toMatch(/1 listener\b/);
  });
});
