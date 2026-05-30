// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({
  addWarning: vi.fn(),
  getWarnings: vi.fn(() => []),
  getEscalation: vi.fn(() => ({ ban_at: null, kick_at: null, mute_at: null })),
  deleteWarning: vi.fn(),
  getTrustedUsers: vi.fn(() => []),
}));
vi.mock("../../../utils/pagination.js", () => ({
  paginate: vi.fn(async (interaction, { items, formatPage }) => {
    const embed = formatPage(items.slice(0, 10), 0, 1);
    return interaction.reply({ embeds: [embed] });
  }),
  formatDuration: (ms) => `${ms}ms`,
}));

import * as warn from "../../../commands/moderation/warn.js";
import { addWarning, getWarnings, getEscalation, deleteWarning } from "../../../database.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember,
  makePermissions, repliedText, lastReply,
} from "../../_helpers/mockDiscord.js";

function setup({ subcommand = "add", options = {}, resolveMember = true, invokerOwner = true } = {}) {
  const guild = makeGuild({ botPermissions: "all", botHighestRolePosition: 100 });
  const tUser = options.user ?? makeUser({ tag: "victim#0001" });
  const tMember = makeMember({ user: tUser, guild, highestRolePosition: 1 });
  tMember.bannable = true; tMember.kickable = true; tMember.moderatable = true;
  guild.members.fetch = vi.fn(async () => (resolveMember ? tMember : null));
  const invoker = makeUser({ tag: "mod#0001" });
  if (invokerOwner) guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [], highestRolePosition: 50 });
  const interaction = makeInteraction({ guild, user: invoker, member, subcommand, options: { user: tUser, ...options } });
  return { interaction, guild, tUser, tMember };
}

beforeEach(() => {
  vi.clearAllMocks();
  getWarnings.mockReturnValue([]);
  getEscalation.mockReturnValue({ ban_at: null, kick_at: null, mute_at: null });
});

describe("warn command", () => {
  it("declares warn metadata", () => {
    expect(warn.data.name).toBe("warn");
  });

  it("refuses a non-admin invoker before any subcommand runs", async () => {
    const { interaction } = setup({ invokerOwner: false, options: { reason: "x" } });
    interaction.member.permissions = makePermissions([]);
    await warn.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
    expect(addWarning).not.toHaveBeenCalled();
  });

  it("add: refuses to warn the bot", async () => {
    const { interaction } = setup({ subcommand: "add", options: { reason: "x" } });
    const botId = interaction.client.user.id;
    interaction.options.getUser = vi.fn(() => ({ id: botId, tag: "irene#0000" }));
    await warn.execute(interaction);
    expect(repliedText(interaction)).toMatch(/can't warn the bot/i);
    expect(addWarning).not.toHaveBeenCalled();
  });

  it("add: stores the warning, DMs the user, and logs (no escalation configured)", async () => {
    getWarnings.mockReturnValue([{ id: 1, reason: "spam" }]);
    const { interaction, guild, tUser } = setup({ subcommand: "add", options: { reason: "spam" } });
    await warn.execute(interaction);
    expect(addWarning).toHaveBeenCalledWith(guild.id, tUser.id, interaction.user.id, "spam");
    expect(tUser.send).toHaveBeenCalled();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/Warning Issued/i);
  });

  it("add: truncates an over-long reason to 500 chars", async () => {
    const longReason = "x".repeat(800);
    getWarnings.mockReturnValue([{ id: 1, reason: longReason.slice(0, 500) }]);
    const { interaction, guild, tUser } = setup({ subcommand: "add", options: { reason: longReason } });
    await warn.execute(interaction);
    const passedReason = addWarning.mock.calls[0][3];
    expect(passedReason.length).toBe(500);
  });

  it("add: auto-bans when warnings reach the ban threshold", async () => {
    getEscalation.mockReturnValue({ ban_at: 3, kick_at: null, mute_at: null });
    getWarnings.mockReturnValue([{ id: 1 }, { id: 2 }, { id: 3 }]); // count >= ban_at
    const { interaction, guild, tUser } = setup({ subcommand: "add", options: { reason: "final straw" } });
    await warn.execute(interaction);
    expect(guild.members.ban).toHaveBeenCalledWith(tUser, expect.objectContaining({ reason: expect.stringContaining("Auto-escalation") }));
    expect(repliedText(interaction)).toMatch(/Auto-banned/i);
  });

  it("add: skips auto-ban (with a note) when the bot lacks BanMembers", async () => {
    getEscalation.mockReturnValue({ ban_at: 2, kick_at: null, mute_at: null });
    getWarnings.mockReturnValue([{ id: 1 }, { id: 2 }]);
    // Bot member without ban permission.
    const guild = makeGuild({ botPermissions: [], botHighestRolePosition: 100 });
    const tUser = makeUser({ tag: "v#0001" });
    const tMember = makeMember({ user: tUser, guild, highestRolePosition: 1 });
    tMember.bannable = true;
    guild.members.fetch = vi.fn(async () => tMember);
    const invoker = makeUser({ tag: "mod#0001" });
    guild.ownerId = invoker.id;
    const member = makeMember({ user: invoker, guild, permissions: "all", highestRolePosition: 50 });
    const interaction = makeInteraction({ guild, user: invoker, member, subcommand: "add", options: { user: tUser, reason: "x" } });
    await warn.execute(interaction);
    expect(guild.members.ban).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Auto-ban skipped/i);
  });

  it("view: reports No Warnings for a clean user", async () => {
    getWarnings.mockReturnValue([]);
    const { interaction } = setup({ subcommand: "view" });
    await warn.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No Warnings/i);
  });

  it("remove: rejects an out-of-range index", async () => {
    getWarnings.mockReturnValue([{ id: 10, reason: "a" }]);
    const { interaction } = setup({ subcommand: "remove", options: { index: 5 } });
    await warn.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Invalid Index/i);
    expect(deleteWarning).not.toHaveBeenCalled();
  });

  it("remove: deletes the targeted warning and logs", async () => {
    getWarnings.mockReturnValue([{ id: 42, reason: "a" }, { id: 43, reason: "b" }]);
    const { interaction, guild } = setup({ subcommand: "remove", options: { index: 1 } });
    await warn.execute(interaction);
    expect(deleteWarning).toHaveBeenCalledWith(42, guild.id);
    expect(repliedText(interaction)).toMatch(/Warning Removed/i);
    expect(sendModLog).toHaveBeenCalledTimes(1);
  });
});
