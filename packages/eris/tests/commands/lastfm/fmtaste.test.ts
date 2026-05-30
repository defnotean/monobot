// Tests for /fmtaste — taste compatibility between two users
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getTopArtists: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmtaste.js";
import { getTopArtists } from "../../../lastfm/api.js";
import { getFmUser } from "../../../lastfm/db.js";
import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedTopArtists = vi.mocked(getTopArtists);
const mockedGetFmUser = vi.mocked(getFmUser);

describe("/fmtaste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits when comparing yourself with yourself", async () => {
    const me = makeUser({ id: "me" });
    const interaction = makeInteraction({ user: me, options: { user: me } });

    await execute(interaction);

    expect(mockedGetFmUser).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/yourself.*100%/i);
  });

  it("requires the caller to be linked", async () => {
    const me = makeUser({ id: "me" });
    const other = makeUser({ id: "other", username: "bob" });
    mockedGetFmUser.mockImplementation(async (id) => (id === "me" ? null : /** @type any */({ lastfm_username: "bob" })));
    const interaction = makeInteraction({ user: me, options: { user: other } });

    await execute(interaction);

    expect(mockedTopArtists).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/you haven't linked/i);
  });

  it("requires the other user to be linked", async () => {
    const me = makeUser({ id: "me" });
    const other = makeUser({ id: "other", username: "bob" });
    mockedGetFmUser.mockImplementation(async (id) => (id === "me" ? /** @type any */({ lastfm_username: "alice" }) : null));
    const interaction = makeInteraction({ user: me, options: { user: other } });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/bob hasn't linked/i);
  });

  it("reports insufficient data when one side has no artists", async () => {
    const me = makeUser({ id: "me" });
    const other = makeUser({ id: "other", username: "bob" });
    mockedGetFmUser.mockImplementation(async (id) =>
      /** @type any */({ lastfm_username: id === "me" ? "alice" : "bob" })
    );
    mockedTopArtists.mockResolvedValueOnce(/** @type any */([{ name: "X", playcount: "5" }]));
    mockedTopArtists.mockResolvedValueOnce(/** @type any */([]));
    const interaction = makeInteraction({ user: me, options: { user: other } });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/not enough scrobbles/i);
  });

  it("computes a Jaccard compatibility score from shared artists", async () => {
    const me = makeUser({ id: "me" });
    const other = makeUser({ id: "other", username: "bob" });
    mockedGetFmUser.mockImplementation(async (id) =>
      /** @type any */({ lastfm_username: id === "me" ? "alice" : "bob" })
    );
    // A: {radiohead, muse}; B: {radiohead, nirvana}
    // shared = 1 (radiohead), union = 3 -> round(1/3*100) = 33%
    mockedTopArtists.mockResolvedValueOnce(/** @type any */([
      { name: "Radiohead", playcount: "100" },
      { name: "Muse", playcount: "20" },
    ]));
    mockedTopArtists.mockResolvedValueOnce(/** @type any */([
      { name: "radiohead", playcount: "50" }, // lowercase -> still matches A's Radiohead
      { name: "Nirvana", playcount: "10" },
    ]));
    const interaction = makeInteraction({ user: me, options: { user: other } });

    await execute(interaction);

    expect(mockedTopArtists).toHaveBeenCalledWith("alice", "overall", 100);
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.title).toContain("33%");
    expect(embed.description).toMatch(/1 shared artists out of 3 unique/);
    // shared artist appears with both play counts. (Use regex matching here:
    // vitest's string `toContain("50")` misbehaves on this particular value,
    // while `toMatch` / `includes` agree the substring is present.)
    const sharedValue = embed.fields[0].value;
    expect(sharedValue).toMatch(/Radiohead/);
    expect(sharedValue).toMatch(/100/);
    expect(sharedValue).toMatch(/ 50 /);
  });

  it("passes a non-default period through to the API", async () => {
    const me = makeUser({ id: "me" });
    const other = makeUser({ id: "other", username: "bob" });
    mockedGetFmUser.mockImplementation(async (id) =>
      /** @type any */({ lastfm_username: id === "me" ? "alice" : "bob" })
    );
    mockedTopArtists.mockResolvedValue(/** @type any */([{ name: "X", playcount: "1" }]));
    const interaction = makeInteraction({ user: me, options: { user: other, period: "3month" } });

    await execute(interaction);

    expect(mockedTopArtists).toHaveBeenCalledWith("alice", "3month", 100);
    expect(mockedTopArtists).toHaveBeenCalledWith("bob", "3month", 100);
  });
});
