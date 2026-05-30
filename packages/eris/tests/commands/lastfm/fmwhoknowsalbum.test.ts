// Tests for /fmwhoknowsalbum — who in this server has listened to an album
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getAlbumInfo: vi.fn(),
  getNowPlaying: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getGuildWhoKnowsAlbum: vi.fn(),
  getLinkedMembers: vi.fn(),
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmwhoknowsalbum.js";
import { getAlbumInfo, getNowPlaying } from "../../../lastfm/api.js";
import { getGuildWhoKnowsAlbum, getLinkedMembers, getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedAlbumInfo = vi.mocked(getAlbumInfo);
const mockedNowPlaying = vi.mocked(getNowPlaying);
const mockedWhoKnows = vi.mocked(getGuildWhoKnowsAlbum);
const mockedLinked = vi.mocked(getLinkedMembers);
const mockedGetFmUser = vi.mocked(getFmUser);

function fullGuild(members) {
  return makeGuild({ members, memberCount: members.length });
}

describe("/fmwhoknowsalbum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to run outside a guild", async () => {
    const interaction = makeInteraction({ guild: null, options: { album: "OK Computer", artist: "Radiohead" } });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  it("with no album and an unlinked caller, asks for an album name", async () => {
    const guild = fullGuild([makeMember({ id: "me", user: makeUser({ id: "me" }) })]);
    const interaction = makeInteraction({ guild, user: makeUser({ id: "me" }), options: { album: null, artist: null } });
    mockedGetFmUser.mockResolvedValue(/** @type any */(null));

    await execute(interaction);

    expect(mockedNowPlaying).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/provide an album name/i);
  });

  it("requires an artist when an album is supplied without one", async () => {
    const guild = fullGuild([makeMember({ id: "me", user: makeUser({ id: "me" }) })]);
    const interaction = makeInteraction({ guild, options: { album: "OK Computer", artist: null } });

    await execute(interaction);

    expect(mockedAlbumInfo).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/provide an artist name/i);
  });

  it("derives album+artist from now playing when the caller is linked", async () => {
    const guild = fullGuild([makeMember({ id: "me", user: makeUser({ id: "me" }) })]);
    const interaction = makeInteraction({ guild, user: makeUser({ id: "me" }), options: { album: null, artist: null } });
    mockedGetFmUser.mockResolvedValue(/** @type any */({ lastfm_username: "alice" }));
    mockedNowPlaying.mockResolvedValue(/** @type any */({
      track: { album: { "#text": "OK Computer" }, artist: { "#text": "Radiohead" } },
    }));
    mockedAlbumInfo.mockResolvedValue(/** @type any */({ artist: "Radiohead", name: "OK Computer", image: [] }));
    mockedLinked.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    expect(mockedNowPlaying).toHaveBeenCalledWith("alice");
    // even though linked is empty (falls to that branch), the album was resolved first
    expect(mockedAlbumInfo).toHaveBeenCalledWith("Radiohead", "OK Computer");
    expect(getLastReplyContent(interaction)).toMatch(/nobody.*linked/i);
  });

  it("renders the leaderboard with resolved names and aggregate footer", async () => {
    const m1 = makeMember({ id: "u1", user: makeUser({ id: "u1" }) });
    m1.displayName = "Alice";
    const guild = fullGuild([m1]);
    const interaction = makeInteraction({ guild, options: { album: "ok computer", artist: "radiohead" } });

    mockedAlbumInfo.mockResolvedValue(/** @type any */({ artist: "Radiohead", name: "OK Computer", image: [{ size: "extralarge", "#text": "http://art.png" }] }));
    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "u1", lastfm_username: "alice" }]));
    mockedWhoKnows.mockResolvedValue(/** @type any */([{ discord_id: "u1", play_count: 250 }]));

    await execute(interaction);

    // queried with canonical resolved names
    expect(mockedWhoKnows).toHaveBeenCalledWith(["u1"], "Radiohead", "OK Computer");
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.author.name).toContain("OK Computer");
    expect(embed.description).toContain("Alice");
    expect(embed.description).toContain("250");
    expect(embed.footer.text).toMatch(/1 listener\b/);
  });
});
