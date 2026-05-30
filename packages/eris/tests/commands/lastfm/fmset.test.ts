// Tests for /fmset — link / unlink a Last.fm account
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getUserInfo: vi.fn(),
  getAllTopArtists: vi.fn(),
  getAllTopAlbums: vi.fn(),
  getAllTopTracks: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  setFmUser: vi.fn(),
  removeFmUser: vi.fn(),
  indexUserArtists: vi.fn(),
  indexUserAlbums: vi.fn(),
  indexUserTracks: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmset.js";
import { getUserInfo, getAllTopArtists, getAllTopAlbums, getAllTopTracks } from "../../../lastfm/api.js";
import { setFmUser, removeFmUser, indexUserArtists } from "../../../lastfm/db.js";
import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedUserInfo = vi.mocked(getUserInfo);
const mockedSet = vi.mocked(setFmUser);
const mockedRemove = vi.mocked(removeFmUser);
const mockedAllArtists = vi.mocked(getAllTopArtists);
const mockedAllAlbums = vi.mocked(getAllTopAlbums);
const mockedAllTracks = vi.mocked(getAllTopTracks);

describe("/fmset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // background index promises must resolve so .then doesn't throw
    mockedAllArtists.mockResolvedValue(/** @type any */([]));
    mockedAllAlbums.mockResolvedValue(/** @type any */([]));
    mockedAllTracks.mockResolvedValue(/** @type any */([]));
  });

  it("remove subcommand unlinks the user and never calls the API", async () => {
    mockedRemove.mockResolvedValue(/** @type any */(undefined));
    const interaction = makeInteraction({
      user: { id: "u-remove" },
      subcommand: "remove",
    });

    await execute(interaction);

    expect(mockedRemove).toHaveBeenCalledWith("u-remove");
    expect(mockedUserInfo).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/unlinked/i);
  });

  it("username subcommand: unknown user (err.code 6) replies with a not-found hint and does not persist", async () => {
    mockedUserInfo.mockRejectedValue(Object.assign(new Error("nope"), { code: 6 }));
    const interaction = makeInteraction({
      user: { id: "u1" },
      subcommand: "username",
      options: { username: "  ghostuser  " },
    });

    await execute(interaction);

    // trimmed before the lookup
    expect(mockedUserInfo).toHaveBeenCalledWith("ghostuser");
    expect(mockedSet).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/couldn't find a last\.fm user/i);
  });

  it("username subcommand: generic API error reports the message", async () => {
    mockedUserInfo.mockRejectedValue(Object.assign(new Error("boom"), { code: 8 }));
    const interaction = makeInteraction({
      user: { id: "u1" },
      subcommand: "username",
      options: { username: "alice" },
    });

    await execute(interaction);

    expect(mockedSet).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/being weird.*boom/i);
  });

  it("username subcommand: success persists the canonical name, kicks off indexing, and shows an embed", async () => {
    mockedUserInfo.mockResolvedValue(/** @type any */({
      name: "AliceCanon",
      playcount: "12345",
      image: [{ size: "large", "#text": "http://img/large.png" }],
    }));
    mockedSet.mockResolvedValue(/** @type any */(undefined));

    const interaction = makeInteraction({
      user: { id: "u-success" },
      subcommand: "username",
      options: { username: "alice" },
    });

    await execute(interaction);

    // persists the API's canonical name (not the raw input)
    expect(mockedSet).toHaveBeenCalledWith("u-success", "AliceCanon");
    // background indexing fired with canonical name
    expect(mockedAllArtists).toHaveBeenCalledWith("AliceCanon", 500);
    const payload = getLastReply(interaction)?.payload;
    expect(payload.embeds).toBeDefined();
    const embed = payload.embeds[0].data;
    expect(embed.title).toMatch(/linked/i);
    expect(embed.description).toContain("AliceCanon");
    expect(embed.description).toContain("12,345"); // toLocaleString of scrobbles
  });
});
