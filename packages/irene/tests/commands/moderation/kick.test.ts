// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTrustedUsers: vi.fn(() => []) }));

import * as kick from "../../../commands/moderation/kick.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember, makeClient,
  makePermissions, repliedText, lastReply, PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

function setup({ resolveMember = true, botPerms = "all", reason, invokerOwner = true } = {}) {
  const client = makeClient();
  const guild = makeGuild({ botPermissions: botPerms, botHighestRolePosition: 100 });
  const tUser = makeUser({ tag: "victim#0001" });
  const tMember = makeMember({ user: tUser, guild, highestRolePosition: 1 });
  guild.members.fetch = vi.fn(async () => (resolveMember ? tMember : null));
  const invoker = makeUser({ tag: "mod#0001" });
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [], highestRolePosition: 50 });
  if (invokerOwner) guild.ownerId = invoker.id;
  const interaction = makeInteraction({
    guild, client, user: invoker, member,
    options: { user: tUser, ...(reason != null ? { reason } : {}) },
  });
  return { interaction, guild, tUser, tMember };
}

beforeEach(() => vi.clearAllMocks());

describe("kick command", () => {
  it("declares kick metadata", () => {
    expect(kick.data.name).toBe("kick");
    expect(typeof kick.execute).toBe("function");
  });

  it("refuses a non-admin invoker", async () => {
    const { interaction, guild } = setup({ invokerOwner: false });
    interaction.member.permissions = makePermissions([]);
    await kick.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it("aborts when bot lacks KickMembers permission", async () => {
    const { interaction } = setup({ botPerms: [] });
    await kick.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Kick Members/);
  });

  it("blocks self-kick", async () => {
    const guild = makeGuild({ botPermissions: "all" });
    const invoker = makeUser();
    guild.ownerId = invoker.id;
    const member = makeMember({ user: invoker, guild, permissions: "all" });
    const interaction = makeInteraction({ guild, user: invoker, member, options: { user: invoker } });
    await kick.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/can't kick yourself/i);
  });

  it("replies Not Found when the target is not in the guild", async () => {
    const { interaction, guild } = setup({ resolveMember: false });
    await kick.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not Found|not in this server/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("kicks the resolved member and logs on the happy path", async () => {
    const { interaction, tMember } = setup({ reason: "rule break" });
    await kick.execute(interaction);
    expect(tMember.kick).toHaveBeenCalledWith("rule break");
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/kicked/i);
  });

  it("emits a failure embed when member.kick throws", async () => {
    const { interaction, tMember } = setup({});
    tMember.kick = vi.fn(async () => { throw new Error("boom"); });
    await kick.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Kick Failed/i);
    expect(repliedText(interaction)).toContain("boom");
    expect(sendModLog).not.toHaveBeenCalled();
  });
});
