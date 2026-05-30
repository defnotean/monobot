// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn(), sendModLog: vi.fn(async () => {}) }));

import * as audit from "../../../commands/moderation/audit.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember,
  makePermissions, repliedText, PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

/** Build an entry shaped like a discord.js GuildAuditLogsEntry the cmd filters on. */
function entry({ action = 22, targetId, executorId, ts = Date.now() } = {}) {
  return {
    action,
    target: targetId ? { id: targetId, tag: "t#0001" } : null,
    executor: executorId ? { id: executorId, tag: "e#0001" } : null,
    createdTimestamp: ts,
    reason: "n/a",
    extra: {},
    changes: [],
  };
}

function setup({ perms = [PermissionFlagsBits.ViewAuditLog], subcommand = "recent", options = {}, entries = [] } = {}) {
  const guild = makeGuild({});
  guild.fetchAuditLogs = vi.fn(async () => ({ entries: { values: () => entries.values() } }));
  const invoker = makeUser({ tag: "mod#0001" });
  const member = makeMember({ user: invoker, guild, permissions: perms });
  const interaction = makeInteraction({ guild, user: invoker, member, subcommand, options });
  // audit.js reads interaction.memberPermissions, not interaction.member.permissions.
  interaction.memberPermissions = makePermissions(perms);
  return { interaction, guild };
}

beforeEach(() => vi.clearAllMocks());

describe("audit command", () => {
  it("declares audit metadata", () => {
    expect(audit.data.name).toBe("audit");
  });

  it("refuses an invoker without ViewAuditLog", async () => {
    const { interaction, guild } = setup({ perms: [] });
    await audit.execute(interaction);
    expect(repliedText(interaction)).toMatch(/View Audit Log/i);
    expect(guild.fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("surfaces an error when the audit-log fetch fails", async () => {
    const { interaction, guild } = setup({});
    guild.fetchAuditLogs = vi.fn(async () => { throw new Error("403"); });
    await audit.execute(interaction);
    expect(repliedText(interaction)).toMatch(/couldn't fetch audit log/i);
  });

  it("reports an empty embed for /audit recent with no recent actions", async () => {
    // One entry but older than the 24h window -> filtered out.
    const old = entry({ ts: Date.now() - 48 * 3_600_000 });
    const { interaction } = setup({ subcommand: "recent", entries: [old] });
    await audit.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No moderation actions in the last/i);
  });

  it("filters /audit user to entries targeting the given user", async () => {
    const target = makeUser({ tag: "target#0001" });
    const hit = entry({ targetId: target.id, ts: Date.now() });
    const miss = entry({ targetId: "other", ts: Date.now() });
    const { interaction } = setup({
      subcommand: "user", options: { target }, entries: [hit, miss],
    });
    await audit.execute(interaction);
    // Non-empty match -> title mentions the target, not the empty message.
    expect(repliedText(interaction)).toMatch(/actions on target#0001/i);
    expect(repliedText(interaction)).not.toMatch(/No moderation actions found/i);
  });

  it("filters /audit by to entries performed by the given moderator", async () => {
    const mod = makeUser({ tag: "themod#0001" });
    const hit = entry({ executorId: mod.id, ts: Date.now() });
    const { interaction } = setup({
      subcommand: "by", options: { moderator: mod }, entries: [hit],
    });
    await audit.execute(interaction);
    expect(repliedText(interaction)).toMatch(/actions by themod#0001/i);
  });
});
