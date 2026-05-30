// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ sendModLog: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTrustedUsers: vi.fn(() => []) }));

import * as unban from "../../../commands/moderation/unban.js";
import { sendModLog } from "../../../utils/logger.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember,
  makePermissions, repliedText, lastReply,
} from "../../_helpers/mockDiscord.js";

const VALID_ID = "123456789012345678"; // 18 digits

function setup({ userId = VALID_ID, botPerms = "all", invokerOwner = true } = {}) {
  const guild = makeGuild({ botPermissions: botPerms });
  const invoker = makeUser({ tag: "mod#0001" });
  if (invokerOwner) guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [] });
  const interaction = makeInteraction({ guild, user: invoker, member, options: { userid: userId, reason: "appeal granted" } });
  return { interaction, guild };
}

beforeEach(() => vi.clearAllMocks());

describe("unban command", () => {
  it("declares unban metadata", () => {
    expect(unban.data.name).toBe("unban");
  });

  it("refuses a non-admin invoker", async () => {
    const { interaction } = setup({ invokerOwner: false });
    interaction.member.permissions = makePermissions([]);
    await unban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
  });

  it("requires the bot to have BanMembers", async () => {
    const { interaction } = setup({ botPerms: [] });
    await unban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Ban Members/);
  });

  it("rejects a malformed user ID before deferring", async () => {
    const { interaction, guild } = setup({ userId: "not-an-id" });
    await unban.execute(interaction);
    expect(lastReply(interaction).content).toMatch(/valid user ID/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(guild.bans.fetch).not.toHaveBeenCalled();
  });

  it("unbans the user and logs on the happy path", async () => {
    const { interaction, guild } = setup({});
    guild.bans.fetch = vi.fn(async () => ({ user: { tag: "freed#0001" } }));
    guild.members.unban = vi.fn(async () => {});
    await unban.execute(interaction);
    expect(guild.members.unban).toHaveBeenCalledWith(VALID_ID, "appeal granted");
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/Unbanned/i);
  });

  it("reports Not Banned when Discord returns the 10026 code", async () => {
    const { interaction, guild } = setup({});
    guild.bans.fetch = vi.fn(async () => { const e = new Error("Unknown Ban"); e.code = 10026; throw e; });
    await unban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not Banned|isn't banned/i);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("reports a generic error for other failures", async () => {
    const { interaction, guild } = setup({});
    guild.bans.fetch = vi.fn(async () => { throw new Error("network"); });
    await unban.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Failed to unban|Error/i);
    expect(repliedText(interaction)).toContain("network");
  });
});
