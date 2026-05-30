// Tests for /fmserverartists — top artists across all linked server members
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/db.js", () => ({
  getLinkedMembers: vi.fn(),
  getServerTopArtists: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmserverartists.js";
import { getLinkedMembers, getServerTopArtists } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedLinked = vi.mocked(getLinkedMembers);
const mockedTop = vi.mocked(getServerTopArtists);

/** Build a guild whose member cache is already "full" so members.fetch() is not invoked. */
function fullGuild(members) {
  // memberCount equal to cache size keeps cache.size >= memberCount*0.8, skipping fetch().
  return makeGuild({ members, memberCount: members.length });
}

describe("/fmserverartists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to run outside a guild and does not defer or hit the DB", async () => {
    const interaction = makeInteraction({ guild: null });

    await execute(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(mockedLinked).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
    // ephemeral guard reply
    expect(getLastReply(interaction)?.payload.ephemeral).toBe(true);
  });

  it("filters out bots before querying linked members", async () => {
    const human = makeMember({ id: "h1", user: makeUser({ id: "h1", bot: false }) });
    const bot = makeMember({ id: "b1", user: makeUser({ id: "b1", bot: true }) });
    const guild = fullGuild([human, bot]);
    const interaction = makeInteraction({ guild });

    mockedLinked.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    // only the human id should be passed through; the bot is excluded
    expect(mockedLinked).toHaveBeenCalledWith(["h1"]);
  });

  it("tells the server nobody has linked when there are no linked members", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild });

    mockedLinked.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    expect(mockedTop).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/nobody.*linked/i);
  });

  it("reports empty when linked members exist but no indexed data", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild });

    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "h1", lastfm_username: "alice" }]));
    mockedTop.mockResolvedValue(/** @type any */([]));

    await execute(interaction);

    // limit defaults to 10 and only linked ids are queried
    expect(mockedTop).toHaveBeenCalledWith(["h1"], 10);
    expect(getLastReplyContent(interaction)).toMatch(/no indexed data/i);
  });

  it("honors the count option and renders an embed of results", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild, options: { count: 3 } });

    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "h1", lastfm_username: "alice" }]));
    mockedTop.mockResolvedValue(/** @type any */([
      { artist_name: "Radiohead", total: 1234, listeners: 2 },
      { artist_name: "Muse", total: 5, listeners: 1 },
    ]));

    await execute(interaction);

    expect(mockedTop).toHaveBeenCalledWith(["h1"], 3);
    const payload = getLastReply(interaction)?.payload;
    expect(payload.embeds).toBeDefined();
    const desc = payload.embeds[0].data.description;
    expect(desc).toContain("Radiohead");
    expect(desc).toContain("1,234"); // fmtNum thousands separator
    expect(desc).toMatch(/2 listeners/); // plural
    expect(desc).toMatch(/1 listener\b/); // singular for the 1-listener row
  });
});
