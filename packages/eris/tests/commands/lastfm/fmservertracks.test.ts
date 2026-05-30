// Tests for /fmservertracks — top tracks across all linked server members
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/db.js", () => ({
  getLinkedMembers: vi.fn(),
  getServerTopTracks: vi.fn(),
}));

import { execute } from "../../../commands/lastfm/fmservertracks.js";
import { getLinkedMembers, getServerTopTracks } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

const mockedLinked = vi.mocked(getLinkedMembers);
const mockedTop = vi.mocked(getServerTopTracks);

function fullGuild(members) {
  return makeGuild({ members, memberCount: members.length });
}

describe("/fmservertracks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to run outside a guild", async () => {
    const interaction = makeInteraction({ guild: null });
    await execute(interaction);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(mockedLinked).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  it("tells the server nobody has linked when no linked members", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild });
    mockedLinked.mockResolvedValue(/** @type any */([]));
    await execute(interaction);
    expect(mockedTop).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/nobody.*linked/i);
  });

  it("reports the no-track-data branch when results are empty", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild });
    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "h1", lastfm_username: "alice" }]));
    mockedTop.mockResolvedValue(/** @type any */([]));
    await execute(interaction);
    expect(mockedTop).toHaveBeenCalledWith(["h1"], 10);
    expect(getLastReplyContent(interaction)).toMatch(/no track data indexed/i);
  });

  it("renders an embed including track + artist names and play counts", async () => {
    const guild = fullGuild([makeMember({ id: "h1", user: makeUser({ id: "h1" }) })]);
    const interaction = makeInteraction({ guild, options: { count: 5 } });
    mockedLinked.mockResolvedValue(/** @type any */([{ discord_id: "h1", lastfm_username: "alice" }]));
    mockedTop.mockResolvedValue(/** @type any */([
      { track_name: "Paranoid Android", artist_name: "Radiohead", total: 99, listeners: 3 },
    ]));
    await execute(interaction);
    expect(mockedTop).toHaveBeenCalledWith(["h1"], 5);
    const desc = getLastReply(interaction)?.payload.embeds[0].data.description;
    expect(desc).toContain("Paranoid Android");
    expect(desc).toContain("Radiohead");
    expect(desc).toMatch(/3 listeners/);
  });
});
