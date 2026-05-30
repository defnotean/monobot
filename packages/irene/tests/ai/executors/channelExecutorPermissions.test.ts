import { describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import { execute as executeChannel } from "../../../ai/executors/channelExecutor.js";
// @ts-expect-error - importing JS module without types
import { execute as executeRole } from "../../../ai/executors/roleExecutor.js";
import { makeChannel, makeGuild, makeMember, makePermissions, makeUser } from "../../_helpers/mockDiscord.js";

function buildHarness({
  actorPermissions = [PermissionFlagsBits.ManageChannels],
  botPermissions = [PermissionFlagsBits.ManageChannels],
}: any = {}) {
  const targetChannel = makeChannel({ name: "general" });
  const category = makeChannel({ name: "Old Category", type: ChannelType.GuildCategory });
  const guild = makeGuild({
    channels: [targetChannel, category],
    botPermissions,
  });
  targetChannel.guild = guild;
  category.guild = guild;

  const actor = makeMember({
    user: makeUser({ id: "actor", username: "actor", tag: "actor#0001" }),
    guild,
    permissions: actorPermissions,
  });
  guild.members.cache.set(actor.id, actor);

  const message = {
    member: actor,
    author: actor.user,
    guild,
    client: { user: guild.members.me.user },
    channel: targetChannel,
  };

  const ctx = {
    guild,
    by: "by test",
    findChannel: vi.fn((g: any, name: string) => g.channels.cache.find((c: any) => c.name.toLowerCase() === name.toLowerCase()) ?? null),
    findMember: vi.fn(),
    findRole: vi.fn(),
  };

  return { guild, category, message, ctx };
}

describe("channel executor permission hardening", () => {
  it("requires ManageChannels instead of accepting ManageGuild", async () => {
    const { guild, message, ctx } = buildHarness({
      actorPermissions: [PermissionFlagsBits.ManageGuild],
    });

    const result = await executeChannel("create_channel", { name: "private", type: "text" }, message, ctx);

    expect(result).toMatch(/manage channels/i);
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it("checks the bot has ManageChannels before channel mutation", async () => {
    const { guild, message, ctx } = buildHarness({
      botPermissions: [],
    });

    const result = await executeChannel("create_channel", { name: "private", type: "text" }, message, ctx);

    expect(result).toMatch(/i need manage channels/i);
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it("requires ManageChannels for category tools routed through roleExecutor", async () => {
    const { guild, message, ctx } = buildHarness({
      actorPermissions: [PermissionFlagsBits.ManageGuild],
    });

    const result = await executeRole("delete_category", { name: "Old Category" }, message, {
      ...ctx,
      parseHexColor: vi.fn(),
      checkRoleAssignment: vi.fn(),
    });

    expect(result).toMatch(/manage channels/i);
    expect(guild.channels.cache.find((c: any) => c.name === "Old Category")?.delete).not.toHaveBeenCalled();
  });

  it("keeps owner bypass for channel mutations", async () => {
    const { guild, message, ctx } = buildHarness({
      actorPermissions: [],
      botPermissions: [PermissionFlagsBits.ManageChannels],
    });
    guild.ownerId = message.member.id;
    guild.members.me.permissions = makePermissions([PermissionFlagsBits.ManageChannels]);

    const result = await executeChannel("create_channel", { name: "owner-made", type: "text" }, message, ctx);

    expect(result).toMatch(/created text channel/i);
    expect(guild.channels.create).toHaveBeenCalled();
  });
});
