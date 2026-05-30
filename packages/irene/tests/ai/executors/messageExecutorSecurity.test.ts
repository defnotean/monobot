import { describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { execute } from "../../../ai/executors/messageExecutor.js";
import { makeChannel, makeGuild, makeMember, makePermissions, makeUser } from "../../_helpers/mockDiscord.js";

function harness({ memberPerms = [], botPerms = "all", channelPerms = null } = {}) {
  const channel = makeChannel({ id: "chan-sec", name: "private" });
  const guild = makeGuild({ channels: [channel], botPermissions: botPerms });
  channel.guild = guild;
  if (channelPerms) {
    channel.permissionsFor = vi.fn((member: any) => {
      if (member?.id === guild.members.me.id) return makePermissions(botPerms);
      return makePermissions(channelPerms);
    });
  }
  const actor = makeMember({
    user: makeUser({ id: "actor", username: "actor", tag: "actor#0001" }),
    guild,
    permissions: memberPerms,
  });
  guild.members.cache.set(actor.id, actor);
  const message = {
    guild,
    member: actor,
    author: actor.user,
    client: { user: guild.members.me.user },
    channel,
  };
  const ctx = {
    guild,
    by: "by test",
    findChannel: vi.fn(() => channel),
  };
  return { channel, guild, message, ctx };
}

describe("messageExecutor security gates", () => {
  it("does not read messages from a channel the caller cannot read", async () => {
    const { channel, message, ctx } = harness({
      channelPerms: [],
      botPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    });

    const result = await execute("read_messages", { channel_name: "private", count: 5 }, message as any, ctx as any);

    expect(result).toMatch(/View Channel and Read Message History/i);
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it("does not unpin messages without caller Manage Messages", async () => {
    const { channel, message, ctx } = harness({
      channelPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      botPerms: [PermissionFlagsBits.ManageMessages],
    });

    const result = await execute("unpin_message", { channel_name: "private", message_id: "m1" }, message as any, ctx as any);

    expect(result).toMatch(/Manage Messages/i);
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it("does not send messages where the caller cannot send", async () => {
    const { channel, message, ctx } = harness({
      channelPerms: [PermissionFlagsBits.ViewChannel],
      botPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });

    const result = await execute("send_message", { channel_name: "private", content: "nope" }, message as any, ctx as any);

    expect(result).toMatch(/View Channel and Send Messages/i);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("does not create threads where the caller lacks thread permission", async () => {
    const { channel, message, ctx } = harness({
      channelPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      botPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads],
    });
    (channel as any).threads = { create: vi.fn() };

    const result = await execute("create_thread", { channel_name: "private", name: "thread" }, message as any, ctx as any);

    expect(result).toMatch(/Create Public Threads/i);
    expect((channel as any).threads.create).not.toHaveBeenCalled();
  });
});
