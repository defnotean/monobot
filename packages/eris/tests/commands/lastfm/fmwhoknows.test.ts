// Tests for /fmwhoknows — who in this server listens to an artist
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/api.js", () => ({
  getArtistInfo: vi.fn(),
}));
vi.mock("../../../lastfm/db.js", () => ({
  getGuildWhoKnows: vi.fn(),
  getLinkedMembers: vi.fn(),
  getCrown: vi.fn(),
  updateCrown: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmwhoknows.js";
import { getArtistInfo } from "../../../lastfm/api.js";
import { getGuildWhoKnows, getLinkedMembers, getCrown, updateCrown } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedArtistInfo = vi.mocked(getArtistInfo);
const mockedWhoKnows = vi.mocked(getGuildWhoKnows);
const mockedLinked = vi.mocked(getLinkedMembers);
const mockedGetCrown = vi.mocked(getCrown);
const mockedUpdateCrown = vi.mocked(updateCrown);

function fullGuild(members) {
  return makeGuild({ members, memberCount: members.length });
}

describe("/fmwhoknows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to run outside a guild", async () => {
    const interaction = makeInteraction({ guild: null, options: { artist: "Radiohead" } });
    await execute(interaction);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  it("tells the server nobody has linked when there are no linked members", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild, options: { artist: "Radiohead" } });
    mockedArtistInfo.mockRejectedValue(new Error("api down")); // falls back to raw input
    mockedLinked.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    expect(mockedWhoKnows).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/nobody.*linked/i);
  });

  it("reports nobody-indexed using the API-resolved (autocorrected) artist name", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild, options: { artist: "radiohed" } });
    mockedArtistInfo.mockResolvedValue(/** @type any */({ name: "Radiohead" }));
    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "h1", lastfm_username: "alice" }]));
    mockedWhoKnows.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    // queried with the corrected name
    expect(mockedWhoKnows).toHaveBeenCalledWith(["h1"], "Radiohead");
    expect(getLastReplyContent(interaction)).toMatch(/Radiohead.*indexed/i);
  });

  it("renders the leaderboard, marks the crown holder, and announces a stolen crown", async () => {
    const m1 = makeMember({ id: "u1", user: makeUser({ id: "u1" }) });
    m1.displayName = "Alice";
    const m2 = makeMember({ id: "u2", user: makeUser({ id: "u2" }) });
    m2.displayName = "Bob";
    const guild = fullGuild([m1, m2]);
    const interaction = makeInteraction({ guild, options: { artist: "Radiohead" } });

    mockedArtistInfo.mockResolvedValue(/** @type any */({ name: "Radiohead" }));
    mockedLinked.mockResolvedValue(/** @type any */([
      { discord_id: "u1", lastfm_username: "alice" },
      { discord_id: "u2", lastfm_username: "bob" },
    ]));
    mockedWhoKnows.mockResolvedValue(/** @type any */([
      { discord_id: "u1", play_count: 500 },
      { discord_id: "u2", play_count: 100 },
    ]));
    // crown changed hands from u2 -> u1
    mockedUpdateCrown.mockResolvedValue(/** @type any */({ changed: true, previousHolder: "u2" }));
    mockedGetCrown.mockResolvedValue(/** @type any */({ discord_id: "u1" }));

    await execute(interaction);

    // crown is updated for the #1 holder with their play count
    expect(mockedUpdateCrown).toHaveBeenCalledWith(guild.id, "Radiohead", "u1", 500);
    const embed = getLastReply(interaction)?.payload.embeds[0].data;
    expect(embed.description).toContain("Alice");
    expect(embed.description).toContain("👑"); // crown icon on the holder
    expect(embed.description).toContain("500");
    // footer aggregates listeners + total plays (500+100)
    expect(embed.footer.text).toMatch(/2 listeners/);
    expect(embed.footer.text).toContain("600");
    // crown-stolen field present
    const stolen = embed.fields.find((f) => /crown stolen/i.test(f.name));
    expect(stolen).toBeDefined();
    expect(stolen.value).toContain("Alice");
    expect(stolen.value).toContain("Bob");
  });
});
