// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// sendModLog hits Discord/DB; stub it. getTrustedUsers is read by the real
// permission gate (requireAdminOrOwner -> isAdminOrOwner).
vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTrustedUsers: vi.fn(() => []) }));

import * as ban from "../../../commands/moderation/ban.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember, makeChannel, makeClient,
  repliedText, lastReply, getReplies, PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

/** Build an interaction whose invoker is an admin and whose target resolves. */
function setup({ targetUser, targetMember, botPerms = "all", days, reason, invokerOwner = true } = {}) {
  const client = makeClient();
  const guild = makeGuild({ botPermissions: botPerms, botHighestRolePosition: 100 });
  const tUser = targetUser ?? makeUser({ tag: "victim#0001" });
  const tMember = targetMember === null
    ? null
    : (targetMember ?? makeMember({ user: tUser, guild, highestRolePosition: 1 }));
  guild.members.fetch = vi.fn(async () => tMember);
  const invoker = makeUser({ tag: "mod#0001" });
  const member = makeMember({
    user: invoker, guild,
    permissions: invokerOwner ? "all" : [],
    highestRolePosition: 50,
  });
  if (invokerOwner) guild.ownerId = invoker.id;
  const interaction = makeInteraction({
    guild, client, user: invoker, member,
    options: { user: tUser, ...(days != null ? { days } : {}), ...(reason != null ? { reason } : {}) },
  });
  return { interaction, guild, tUser, tMember };
}

beforeEach(() => vi.clearAllMocks());

describe("ban command", () => {
  it("declares ban metadata and BanMembers default perm", () => {
    expect(ban.data.name).toBe("ban");
    expect(typeof ban.execute).toBe("function");
  });

  it("refuses a non-admin/non-permitted invoker (owner gate)", async () => {
    // Invoker is NOT owner and has no permissions -> requireAdminOrOwner fails.
    const { interaction, guild } = setup({ invokerOwner: false });
    interaction.member.permissions = (await import("../../_helpers/mockDiscord.js")).makePermissions([]);
    await ban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
    expect(guild.members.ban).not.toHaveBeenCalled();
  });

  it("blocks self-ban without touching the guild ban API", async () => {
    const invoker = makeUser({ tag: "self#0001" });
    const guild = makeGuild({ botPermissions: "all" });
    guild.ownerId = invoker.id;
    const member = makeMember({ user: invoker, guild, permissions: "all" });
    const interaction = makeInteraction({ guild, user: invoker, member, options: { user: invoker } });
    await ban.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/can't ban yourself/i);
    expect(guild.members.ban).not.toHaveBeenCalled();
  });

  it("refuses to ban the bot itself", async () => {
    const { interaction } = setup({});
    // Make the target the bot user.
    const botId = interaction.client.user.id;
    interaction.options.getUser = vi.fn(() => ({ id: botId, tag: "irene#0000" }));
    await ban.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/not banning myself/i);
  });

  it("aborts when the bot lacks BanMembers permission", async () => {
    const { interaction, guild } = setup({ botPerms: [] });
    await ban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Ban Members/);
    expect(guild.members.ban).not.toHaveBeenCalled();
  });

  it("blocks when target outranks the moderator (hierarchy gate)", async () => {
    // Target member has equal/higher role than invoker.
    const guild = makeGuild({ botPermissions: "all", botHighestRolePosition: 100 });
    const invoker = makeUser({ tag: "mod#0001" });
    const member = makeMember({ user: invoker, guild, permissions: "all", highestRolePosition: 5 });
    // Invoker is NOT owner so the role-position check applies.
    const tUser = makeUser({ tag: "boss#0001" });
    const tMember = makeMember({ user: tUser, guild, highestRolePosition: 9 });
    guild.members.fetch = vi.fn(async () => tMember);
    const interaction = makeInteraction({ guild, user: invoker, member, options: { user: tUser } });
    await ban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/higher or equal role/i);
    expect(guild.members.ban).not.toHaveBeenCalled();
  });

  it("bans the target, DMs them, and writes a mod log on the happy path", async () => {
    const { interaction, guild, tUser } = setup({ days: 3, reason: "spamming" });
    await interaction; // noop to keep linter calm
    await ban.execute(interaction);
    expect(guild.members.ban).toHaveBeenCalledWith(tUser, { deleteMessageDays: 3, reason: "spamming" });
    expect(tUser.send).toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/banned/i);
    expect(repliedText(interaction)).toContain("spamming");
  });

  it("still succeeds (and notes DM failure) when the user has DMs disabled", async () => {
    const { interaction, tUser } = setup({});
    tUser.send = vi.fn(async () => { throw new Error("Cannot send messages to this user"); });
    await ban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Could not DM user|Failed/i);
  });

  it("reports a failure embed when the ban API throws", async () => {
    const { interaction, guild } = setup({});
    guild.members.ban = vi.fn(async () => { throw new Error("Missing Permissions"); });
    await ban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Ban Failed/i);
    expect(repliedText(interaction)).toContain("Missing Permissions");
    expect(sendModLog).not.toHaveBeenCalled();
  });
});
