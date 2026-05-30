// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";

import { execute, data } from "../../../commands/setup/setup-server.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeGuild,
  makeRole,
  makeChannel,
  repliedText,
  lastReply,
  getReplies,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => vi.clearAllMocks());

describe("/setup-server", () => {
  it("declares the setup-server command", () => {
    expect(data.name).toBe("setup-server");
  });

  it("blocks a non-admin and never touches the guild", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ guild, permissions: [] });

    await execute(interaction);

    expect(guild.roles.create).not.toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });

  it("creates the standard roles + categories + channels on a blank server", async () => {
    // guild.client.user.id must resolve a bot member in members.cache for the
    // role-position step. The helper seeds members.me; mirror it into the cache.
    const guild = makeGuild();
    guild.client = { user: guild.members.me.user };
    guild.members.cache.set(guild.members.me.user.id, guild.members.me);
    guild.members.me.roles.highest.position = 50;
    // setPositions isn't provided by the helper — add a spy.
    guild.roles.setPositions = vi.fn(async () => {});

    const interaction = makeInteraction({
      guild,
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    // 3 roles created
    expect(guild.roles.create).toHaveBeenCalledTimes(3);
    // 4 categories + 11 channels = 15 channel.create calls
    expect(guild.channels.create).toHaveBeenCalledTimes(15);
    // categories are created with the Category type
    const catCalls = guild.channels.create.mock.calls.filter(
      ([opts]) => opts.type === ChannelType.GuildCategory,
    );
    expect(catCalls).toHaveLength(4);

    const text = repliedText(interaction);
    expect(text).toMatch(/Server Setup Complete/i);
    expect(text).toMatch(/Admin/);
    expect(text).toMatch(/Moderator/);
  });

  it("reports 'already set up' when every role + channel already exists", async () => {
    // Pre-seed all 3 roles + 4 categories + their child channels.
    const roles = ["Admin", "Moderator", "Member"].map((name) => makeRole({ name }));
    const structure = {
      INFO: ["rules", "announcements", "roles"],
      GENERAL: ["general", "media", "bot-commands"],
      MODERATION: ["mod-log", "mod-chat"],
      VOICE: ["General Voice", "Music", "AFK"],
    };
    const channels = [];
    for (const [catName, kids] of Object.entries(structure)) {
      const cat = makeChannel({ name: catName, type: ChannelType.GuildCategory });
      channels.push(cat);
      for (const k of kids) {
        channels.push(makeChannel({ name: k, parentId: cat.id }));
      }
    }
    const guild = makeGuild({ roles, channels });
    guild.client = { user: guild.members.me.user };
    guild.members.cache.set(guild.members.me.user.id, guild.members.me);
    guild.roles.setPositions = vi.fn(async () => {});

    const interaction = makeInteraction({
      guild,
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(guild.roles.create).not.toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Already Set Up/i);
  });

  it("reports a failure embed when guild creation throws", async () => {
    const guild = makeGuild();
    guild.client = { user: guild.members.me.user };
    guild.members.cache.set(guild.members.me.user.id, guild.members.me);
    guild.roles.setPositions = vi.fn(async () => {});
    guild.roles.create = vi.fn(async () => {
      throw new Error("boom-from-discord");
    });

    const interaction = makeInteraction({
      guild,
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    const text = repliedText(interaction);
    expect(text).toMatch(/Setup Failed/i);
    expect(text).toContain("boom-from-discord");
    // It edits the deferred reply rather than throwing.
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
