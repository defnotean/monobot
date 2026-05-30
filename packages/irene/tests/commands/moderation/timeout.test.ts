// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTrustedUsers: vi.fn(() => []) }));

import * as timeout from "../../../commands/moderation/timeout.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember,
  makePermissions, repliedText,
} from "../../_helpers/mockDiscord.js";

function setup({ resolveMember = true, botPerms = "all", duration = "10m", invokerOwner = true } = {}) {
  const guild = makeGuild({ botPermissions: botPerms, botHighestRolePosition: 100 });
  const tUser = makeUser({ tag: "victim#0001" });
  const tMember = makeMember({ user: tUser, guild, highestRolePosition: 1 });
  guild.members.fetch = vi.fn(async () => (resolveMember ? tMember : null));
  const invoker = makeUser({ tag: "mod#0001" });
  if (invokerOwner) guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [], highestRolePosition: 50 });
  const interaction = makeInteraction({ guild, user: invoker, member, options: { user: tUser, duration, reason: "test" } });
  return { interaction, tMember };
}

beforeEach(() => vi.clearAllMocks());

describe("timeout command", () => {
  it("declares timeout metadata", () => {
    expect(timeout.data.name).toBe("timeout");
  });

  it("refuses a non-admin invoker", async () => {
    const { interaction } = setup({ invokerOwner: false });
    interaction.member.permissions = makePermissions([]);
    await timeout.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
  });

  it("requires the bot to have ModerateMembers", async () => {
    const { interaction } = setup({ botPerms: [] });
    await timeout.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Moderate Members/);
  });

  it("replies Not Found when target is absent", async () => {
    const { interaction } = setup({ resolveMember: false });
    await timeout.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not Found|not found/i);
  });

  it("translates the duration choice to milliseconds when applying the timeout", async () => {
    const { interaction, tMember } = setup({ duration: "1h" });
    await timeout.execute(interaction);
    // "1h" must map to 60*60*1000 = 3,600,000 ms, not the literal string.
    expect(tMember.timeout).toHaveBeenCalledWith(60 * 60 * 1000, "test");
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/Timed Out/i);
  });

  it("reports a failure embed when member.timeout throws", async () => {
    const { interaction, tMember } = setup({});
    tMember.timeout = vi.fn(async () => { throw new Error("api down"); });
    await timeout.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Timeout Failed/i);
    expect(repliedText(interaction)).toContain("api down");
    expect(sendModLog).not.toHaveBeenCalled();
  });
});
