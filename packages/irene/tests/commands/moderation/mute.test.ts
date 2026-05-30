// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTrustedUsers: vi.fn(() => []) }));

import * as mute from "../../../commands/moderation/mute.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember, makeChannel, makeRole,
  makePermissions, repliedText, lastReply,
} from "../../_helpers/mockDiscord.js";

function setup({ resolveMember = true, botPerms = "all", existingMuteRole = false, alreadyMuted = false } = {}) {
  const guild = makeGuild({ botPermissions: botPerms, botHighestRolePosition: 100 });
  const tUser = makeUser({ tag: "victim#0001" });
  const tMember = makeMember({ user: tUser, guild, highestRolePosition: 1 });
  guild.members.fetch = vi.fn(async () => (resolveMember ? tMember : null));

  if (existingMuteRole) {
    const muteRole = makeRole({ name: "Muted", position: 2 });
    guild.roles.cache.set(muteRole.id, muteRole);
    if (alreadyMuted) tMember.roles.cache.set(muteRole.id, muteRole);
  }

  const invoker = makeUser({ tag: "mod#0001" });
  guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: "all", highestRolePosition: 50 });
  const interaction = makeInteraction({ guild, user: invoker, member, options: { user: tUser } });
  return { interaction, guild, tUser, tMember };
}

beforeEach(() => vi.clearAllMocks());

describe("mute command", () => {
  it("declares mute metadata", () => {
    expect(mute.data.name).toBe("mute");
  });

  it("requires the bot to have ManageRoles", async () => {
    const { interaction } = setup({ botPerms: [] });
    await mute.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Roles/);
  });

  it("replies User not found when target is absent", async () => {
    const { interaction } = setup({ resolveMember: false });
    await mute.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/not found/i);
  });

  it("creates the Muted role when missing, then mutes and logs", async () => {
    // No existing Muted role; one text channel so the overwrite loop runs.
    const { interaction, guild, tMember } = setup({ existingMuteRole: false });
    const ch = makeChannel({ name: "general", guild });
    guild.channels.cache.set(ch.id, ch);
    await mute.execute(interaction);
    expect(guild.roles.create).toHaveBeenCalled();
    expect(ch.permissionOverwrites.edit).toHaveBeenCalled();
    expect(tMember.roles.add).toHaveBeenCalled();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/muted/i);
  });

  it("reuses an existing Muted role without recreating it", async () => {
    const { interaction, guild, tMember } = setup({ existingMuteRole: true });
    await mute.execute(interaction);
    expect(guild.roles.create).not.toHaveBeenCalled();
    expect(tMember.roles.add).toHaveBeenCalled();
  });

  it("short-circuits when the user is already muted", async () => {
    const { interaction, tMember } = setup({ existingMuteRole: true, alreadyMuted: true });
    await mute.execute(interaction);
    expect(tMember.roles.add).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/already muted/i);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("reports failure when roles.add throws", async () => {
    const { interaction, tMember } = setup({ existingMuteRole: true });
    tMember.roles.add = vi.fn(async () => { throw new Error("nope"); });
    await mute.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Failed to mute/i);
    expect(repliedText(interaction)).toContain("nope");
  });
});
