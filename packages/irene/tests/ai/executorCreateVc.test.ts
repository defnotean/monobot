import { describe, expect, it, vi } from "vitest";
import { ChannelType, Collection } from "discord.js";

vi.mock("../../ai/firewall.js", () => ({
  checkInjection: async () => ({ blocked: false }),
  logBlockedAttempt: vi.fn(),
  logRedosEvent: vi.fn(),
  seedPatternsAtBoot: vi.fn(),
  getRedosLog: () => [],
  shutdown: vi.fn(),
  spotlight: (text: string) => text,
}));

const { executeTool } = await import("../../ai/executor.js");
const { getGuildSettings } = await import("../../database.js");

function makeGuild() {
  const guild: any = {
    id: "100000000000000001",
    ownerId: "200000000000000002",
    channels: {
      cache: new Collection<string, any>(),
      create: vi.fn(async () => {
        throw new Error("create_channel should not be called");
      }),
    },
    roles: {
      everyone: { id: "100000000000000001" },
      cache: new Collection(),
    },
  };

  const category = {
    id: "300000000000000003",
    name: "Games",
    type: ChannelType.GuildCategory,
    position: 0,
    parentId: null,
  };
  const voice = {
    id: "400000000000000004",
    name: "⚙️ Game Generator",
    type: ChannelType.GuildVoice,
    position: 1,
    parentId: category.id,
  };
  guild.channels.cache.set(category.id, category);
  guild.channels.cache.set(voice.id, voice);
  return { guild, voice };
}

function makeMessage(content = "Irene Setup this vc to be a create") {
  const { guild, voice } = makeGuild();
  const member: any = {
    id: "200000000000000002",
    guild,
    voice: { channel: voice },
    permissions: { has: () => true },
  };
  return {
    content,
    guild,
    member,
    author: { id: member.id, username: "defnotean" },
    client: { user: { id: "500000000000000005" } },
  } as any;
}

describe("create VC tool routing", () => {
  it("uses the requester's current VC for 'this VC'", async () => {
    const message = makeMessage();

    const result = await executeTool("set_create_vc_channel", { channel_id: "current" }, message);

    expect(result).toContain("Create-VC trigger set");
    expect(getGuildSettings(message.guild.id).create_vc_channel_id).toBe(message.member.voice.channel.id);
  });

  it("resolves voice channel names despite emoji variation selectors", async () => {
    const message = makeMessage("set ⚙ Game Generator as the create vc");

    const result = await executeTool("set_create_vc_channel", { channel_name: "⚙ Game Generator" }, message);

    expect(result).toContain("Create-VC trigger set");
    expect(getGuildSettings(message.guild.id).create_vc_channel_id).toBe(message.member.voice.channel.id);
  });

  it("blocks accidental create_channel calls for existing/current create-VC setup", async () => {
    const message = makeMessage();

    const result = await executeTool("create_channel", { name: "⚙ Game Generator", type: "voice" }, message);

    expect(result).toMatch(/not creating a new channel/i);
    expect(message.guild.channels.create).not.toHaveBeenCalled();
  });

  it("lists channel ids for follow-up tool calls", async () => {
    const message = makeMessage("list channels");

    const result = await executeTool("list_channels", {}, message);

    expect(result).toContain("⚙️ Game Generator");
    expect(result).toContain("[id:400000000000000004]");
  });
});
