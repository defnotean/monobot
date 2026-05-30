import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeClient, makeUser, makeMember, lastReply, repliedText, Collection } from "../../_helpers/mockDiscord.js";

// dev_stats gates on config.ownerId. Mock config so the owner id is deterministic.
vi.mock("../../../config.js", () => ({
  default: {
    ownerId: "owner-123",
    colors: { primary: 0x5865f2, info: 0x3498db, success: 0x2ecc71, error: 0xe74c3c, warning: 0xf1c40f },
  },
}));

import * as devStatsCmd from "../../../commands/utility/dev_stats.js";

function ownerInteraction() {
  const client = makeClient({
    uptime: 1000,
    guilds: { cache: new Collection() },
    users: { cache: new Collection() },
    channels: { cache: new Collection() },
  });
  client.ws = { ping: 50 };
  const user = makeUser({ id: "owner-123" });
  const member = makeMember({ user });
  member.voice = { channel: null };
  return makeInteraction({ client, user, member });
}

describe("utility/dev_stats owner gate", () => {
  it("refuses non-owners and never builds the stats embed", async () => {
    const client = makeClient({ uptime: 1000, guilds: { cache: new Collection() }, users: { cache: new Collection() }, channels: { cache: new Collection() } });
    const stranger = makeUser({ id: "not-the-owner" });
    const member = makeMember({ user: stranger });
    member.voice = { channel: null };
    const interaction = makeInteraction({ client, user: stranger, member });

    await devStatsCmd.execute(interaction);

    expect(repliedText(interaction)).toContain("dev only");
    expect(interaction.reply.mock.calls[0][0].ephemeral).toBe(true);
    // no embed in the refusal
    expect(interaction.reply.mock.calls[0][0].embeds).toBeUndefined();
  });

  it("lets the owner through and reports cache sizes + ping", async () => {
    const interaction = ownerInteraction();
    // makeInteraction wires the interaction's own guild into client.guilds.cache,
    // so the guild cache already holds exactly 1 entry. Seed the user cache.
    interaction.client.users.cache.set("u1", {});
    interaction.client.users.cache.set("u2", {});
    const expectedGuilds = String(interaction.client.guilds.cache.size);
    const expectedChannels = String(interaction.client.channels.cache.size);

    await devStatsCmd.execute(interaction);

    const payload = lastReply(interaction);
    const embed = payload.embeds[0].data ?? payload.embeds[0];
    expect(embed.title).toContain("Developer Statistics");
    const f = (n: string) => embed.fields.find((x: any) => x.name === n)?.value;
    expect(f("Ping")).toBe("50ms");
    expect(f("Guilds Cache")).toBe(expectedGuilds);
    expect(f("Users Cache")).toBe("2");
    expect(f("Channels Cache")).toBe(expectedChannels);
    expect(payload.ephemeral).toBe(true);
  });

  it("does not post the voice debug follow-up when the owner is not in a voice channel", async () => {
    const interaction = ownerInteraction();
    await devStatsCmd.execute(interaction);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("posts a voice activity debug follow-up when the owner is in a voice channel", async () => {
    const interaction = ownerInteraction();
    const vcMembers = new Collection<string, any>();
    vcMembers.set("m1", { user: { bot: false, username: "Gamer" }, presence: { activities: [{ type: 0, name: "Game", state: "lvl 1", details: "boss" }] } });
    vcMembers.set("bot", { user: { bot: true, username: "B" }, presence: null });
    interaction.member.voice = { channel: { name: "General VC", members: vcMembers } };

    await devStatsCmd.execute(interaction);

    expect(interaction.followUp).toHaveBeenCalled();
    const txt = interaction.followUp.mock.calls[0][0].content;
    expect(txt).toContain("General VC");
    expect(txt).toContain("Gamer");
    // bot member is skipped
    expect(txt).not.toContain("**B**");
  });
});
