import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

vi.mock("../../../database.js", () => ({
  setWelcomeChannel: vi.fn(),
  setLogChannel: vi.fn(),
  setAutorole: vi.fn(),
  setAccessRole: vi.fn(),
  setDmResults: vi.fn(),
  setStatsChannels: vi.fn(),
  addReactionRole: vi.fn(),
  removeReactionRole: vi.fn(),
  setStarboard: vi.fn(),
  setColorRoles: vi.fn(),
  getGuildSettings: vi.fn(() => ({})),
  getPatchFeeds: vi.fn(() => ({ global: { ping_role_ids: [] }, feeds: [] })),
  setPatchFeeds: vi.fn(),
  getTwitchConfig: vi.fn(() => ({})),
  setTwitchConfig: vi.fn(),
  setWelcomeEmbed: vi.fn(),
  getCustomCommand: vi.fn(),
  setCustomCommand: vi.fn(),
  deleteCustomCommand: vi.fn(),
  listCustomCommands: vi.fn(() => []),
}));

// @ts-expect-error - importing JS module without types
import { execute as executeSetup } from "../../../ai/executors/setupExecutor.js";
// @ts-expect-error - importing JS module without types
import { execute as executeMessage } from "../../../ai/executors/messageExecutor.js";
import { addReactionRole, setAccessRole, setAutorole, setColorRoles } from "../../../database.js";
import { makeChannel, makeGuild, makeMember, makePermissions, makeRole, makeUser } from "../../_helpers/mockDiscord.js";

function dangerousRole() {
  return makeRole({
    id: "danger-role",
    name: "Adminish",
    position: 2,
    permissions: makePermissions([PermissionFlagsBits.ManageRoles]),
  });
}

function harness(role = dangerousRole()) {
  const channel = makeChannel({ id: "channel-1", name: "roles" });
  const guild = makeGuild({
    channels: [channel],
    roles: [role],
    botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels],
    botHighestRolePosition: 100,
  });
  channel.guild = guild;
  const actor = makeMember({
    user: makeUser({ id: "actor", username: "actor", tag: "actor#0001" }),
    guild,
    permissions: [PermissionFlagsBits.ManageGuild],
    highestRolePosition: 50,
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
    findChannel: vi.fn((g: any, name: string) => g.channels.cache.find((c: any) => c.name.toLowerCase() === name.toLowerCase()) ?? null),
    findRole: vi.fn((g: any, name: string) => g.roles.cache.find((r: any) => r.name.toLowerCase() === name.toLowerCase()) ?? null),
    findRoles: vi.fn(),
    findMember: vi.fn(),
  };
  return { guild, channel, message, ctx, role };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("self-assignable role surfaces", () => {
  it("rejects dangerous access roles", async () => {
    const { message, ctx } = harness();

    const result = await executeSetup("set_access_role", { role_name: "Adminish" }, message, ctx);

    expect(result).toMatch(/elevated permissions/i);
    expect(setAccessRole).not.toHaveBeenCalled();
  });

  it("rejects dangerous autoroles in the AI setup path", async () => {
    const { message, ctx } = harness();

    const result = await executeSetup("set_autorole", { role_name: "Adminish" }, message, ctx);

    expect(result).toMatch(/elevated permissions/i);
    expect(setAutorole).not.toHaveBeenCalled();
  });

  it("rejects dangerous reaction-role mappings", async () => {
    const { message, ctx } = harness();

    const result = await executeSetup("add_reaction_role", { message_id: "msg-1", emoji: "✅", role_name: "Adminish" }, message, ctx);

    expect(result).toMatch(/elevated permissions/i);
    expect(addReactionRole).not.toHaveBeenCalled();
  });

  it("does not save dangerous color roles", async () => {
    const { message, ctx } = harness();

    const result = await executeSetup("setup_color_roles", {
      channel_name: "roles",
      colors: [{ name: "Adminish", hex: "#ff0000" }],
    }, message, ctx);

    expect(result).toMatch(/with 1 colors/i);
    expect(setColorRoles).toHaveBeenCalledWith(message.guild.id, []);
    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it("refuses custom message role buttons for dangerous roles", async () => {
    const { message, ctx, role, channel } = harness();
    channel.send = vi.fn(async () => ({}));

    const result = await executeMessage("send_message", {
      channel_name: "roles",
      embed_title: "Pick roles",
      buttons: [{ label: "Admin", style: "secondary", role_id: role.id }],
    }, message, ctx);

    expect(result).toMatch(/elevated permissions/i);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("posts harmless role pickers", async () => {
    const harmless = makeRole({
      id: "member-role",
      name: "Member",
      position: 2,
      permissions: makePermissions([]),
    });
    const { message, ctx, channel } = harness(harmless);
    channel.send = vi.fn(async () => ({}));

    const result = await executeSetup("setup_role_picker", {
      channel_name: "roles",
      title: "Pick",
      roles: [{ name: "Member" }],
    }, message, ctx);

    expect(result).toMatch(/role picker posted/i);
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));
  });
});
