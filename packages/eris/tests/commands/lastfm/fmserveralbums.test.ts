// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lastfm/db.js", () => ({
  getLinkedMembers: vi.fn(),
  getServerTopAlbums: vi.fn(),
}));

import * as cmd from "../../../commands/lastfm/fmserveralbums.js";
import { getLinkedMembers, getServerTopAlbums } from "../../../lastfm/db.js";
import { makeInteraction, makeGuild, makeMember, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

/** Build a guild whose member cache is already "full" so no fetch is attempted. */
function guildWithMembers(members) {
  const guild = makeGuild({ members, memberCount: members.length });
  return guild;
}

describe("lastfm/fmserveralbums command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports data named 'fmserveralbums'", () => {
    expect(cmd.data?.name).toBe("fmserveralbums");
    expect(typeof cmd.execute).toBe("function");
  });

  it("refuses in DMs before deferring", async () => {
    const interaction = makeInteraction({ guild: null, options: {} });
    await cmd.execute(interaction);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(getLinkedMembers).not.toHaveBeenCalled();
    const reply = getLastReply(interaction);
    expect(reply.content).toBe("this command only works in servers");
    expect(reply.payload.ephemeral).toBe(true);
  });

  it("filters out bot members when collecting member ids", async () => {
    const human = makeMember({ id: "h1", user: makeUser({ id: "h1", username: "human" }) });
    const botMember = makeMember({ id: "b1", user: makeUser({ id: "b1", username: "bot", bot: true }) });
    const guild = guildWithMembers([human, botMember]);
    getLinkedMembers.mockResolvedValue([{ discord_id: "h1" }]);
    getServerTopAlbums.mockResolvedValue([
      { album_name: "Al", artist_name: "Ar", total: "20", listeners: 2 },
    ]);
    const interaction = makeInteraction({ guild, options: {} });
    await cmd.execute(interaction);
    const passedIds = getLinkedMembers.mock.calls[0][0];
    expect(passedIds).toContain("h1");
    expect(passedIds).not.toContain("b1");
  });

  it("reports when nobody is linked", async () => {
    const human = makeMember({ id: "h1", user: makeUser({ id: "h1" }) });
    const guild = guildWithMembers([human]);
    getLinkedMembers.mockResolvedValue([]);
    const interaction = makeInteraction({ guild, options: {} });
    await cmd.execute(interaction);
    expect(getServerTopAlbums).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/nobody in this server has linked/);
  });

  it("reports when no album data is indexed", async () => {
    const human = makeMember({ id: "h1", user: makeUser({ id: "h1" }) });
    const guild = guildWithMembers([human]);
    getLinkedMembers.mockResolvedValue([{ discord_id: "h1" }]);
    getServerTopAlbums.mockResolvedValue([]);
    const interaction = makeInteraction({ guild, options: {} });
    await cmd.execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/no album data indexed yet/);
  });

  it("defaults count to 10 and passes linked ids to the aggregator", async () => {
    const human = makeMember({ id: "h1", user: makeUser({ id: "h1" }) });
    const guild = guildWithMembers([human]);
    getLinkedMembers.mockResolvedValue([{ discord_id: "h1" }, { discord_id: "h2" }]);
    getServerTopAlbums.mockResolvedValue([
      { album_name: "Al", artist_name: "Ar", total: "30", listeners: 1 },
    ]);
    const interaction = makeInteraction({ guild, options: {} });
    await cmd.execute(interaction);
    expect(getServerTopAlbums).toHaveBeenCalledWith(["h1", "h2"], 10);
  });

  it("honors explicit count and pluralizes listeners + linked-member footer", async () => {
    const human = makeMember({ id: "h1", user: makeUser({ id: "h1" }) });
    const guild = guildWithMembers([human]);
    getLinkedMembers.mockResolvedValue([{ discord_id: "h1" }]);
    getServerTopAlbums.mockResolvedValue([
      { album_name: "Solo", artist_name: "X", total: "5", listeners: 1 },
      { album_name: "Shared", artist_name: "Y", total: "9", listeners: 3 },
    ]);
    const interaction = makeInteraction({ guild, options: { count: 5 } });
    await cmd.execute(interaction);
    expect(getServerTopAlbums).toHaveBeenCalledWith(["h1"], 5);
    const embed = getLastReply(interaction).payload.embeds[0].data;
    expect(embed.description).toContain("1 listener"); // singular
    expect(embed.description).toContain("3 listeners"); // plural
    expect(embed.footer.text).toContain("1 linked member"); // singular
  });
});
