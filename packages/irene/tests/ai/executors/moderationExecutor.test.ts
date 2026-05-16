import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import { execute as executeMod } from "../../../ai/executors/moderationExecutor.js";

// Mock the database / logger / twin layer so a missing-perm reject can't
// fire a side-effect even if the gate regresses. Test asserts both the
// returned error string AND that none of these spies were called.
vi.mock("../../../database.js", () => ({
  addWarning: vi.fn(),
  getWarnings: vi.fn(() => []),
  deleteWarning: vi.fn(),
  clearWarnings: vi.fn(),
  logAudit: vi.fn(),
  removeTempBan: vi.fn(),
  getGuildSettings: vi.fn(() => ({})),
  getEscalation: vi.fn(() => ({ ban_at: null, kick_at: null, mute_at: null })),
  addTempBan: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({
  log: vi.fn(),
  sendModLog: vi.fn(),
}));

vi.mock("../../../utils/twinPunish.js", () => ({
  firePunishSignal: vi.fn(async () => undefined),
}));

import { addWarning, logAudit, clearWarnings, deleteWarning, addTempBan } from "../../../database.js";
import { sendModLog } from "../../../utils/logger.js";
import { firePunishSignal } from "../../../utils/twinPunish.js";

// Build a member that lacks `lackingPerm`. Crucially:
// - id ≠ guild.ownerId so the owner short-circuit doesn't pass
// - permissions.has(Administrator) returns false so the admin short-circuit
//   doesn't pass
// - permissions.has(lackingPerm) returns false
function buildNonPermedMember(lackingPerm: bigint) {
  return {
    id: "user-without-perm",
    permissions: {
      has: (perm: bigint) => {
        if (perm === PermissionFlagsBits.Administrator) return false;
        if (perm === lackingPerm) return false;
        // Other perms — irrelevant for these gate tests.
        return false;
      },
    },
  };
}

function buildFakeGuild() {
  return {
    id: "guild-1",
    ownerId: "the-owner-not-the-caller",
    name: "Test Guild",
    client: { user: { id: "bot-id" } },
    members: { fetch: vi.fn() },
    bans: { fetch: vi.fn() },
    roles: { cache: { get: vi.fn(), find: vi.fn() } },
  };
}

function buildMessage(member: any, guild: any) {
  return {
    member,
    author: { id: member.id, tag: "tester#0001", username: "tester" },
    client: guild.client,
    channel: { id: "channel-1", send: vi.fn() },
    guild,
  };
}

function buildCtx(guild: any) {
  // findMember / findChannel return a sentinel target so if a gate
  // erroneously falls through, the action would attempt a real op
  // and our DB/Discord spies would record it.
  const target = {
    id: "target-victim",
    user: { id: "target-victim", tag: "victim#0001", username: "victim", createdTimestamp: 0 },
    bannable: true,
    ban: vi.fn(),
    kick: vi.fn(),
    timeout: vi.fn(),
    send: vi.fn(),
    isCommunicationDisabled: () => false,
    nickname: null,
    joinedTimestamp: 0,
    roles: { cache: { has: () => false } },
  };
  return {
    guild,
    by: "test-author",
    findChannel: vi.fn(() => guild.client.channel),
    findMember: vi.fn(() => target),
    checkHierarchy: vi.fn(() => null),
    _target: target,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moderationExecutor — per-tool permission re-check (HIGH audit finding)", () => {
  it("ban_user rejects when caller lacks BanMembers — and runs zero side effects", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.BanMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);

    const result = await executeMod("ban_user", { username: "victim", reason: "test" }, msg, ctx);

    expect(String(result)).toMatch(/can't ban/i);
    expect(ctx._target.ban).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
    expect(firePunishSignal).not.toHaveBeenCalled();
    // findMember should NOT have run either — the gate sits before lookup.
    expect(ctx.findMember).not.toHaveBeenCalled();
  });

  it("kick_user rejects when caller lacks KickMembers — and runs zero side effects", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.KickMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);

    const result = await executeMod("kick_user", { username: "victim", reason: "test" }, msg, ctx);

    expect(String(result)).toMatch(/can't kick/i);
    expect(ctx._target.kick).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
    expect(firePunishSignal).not.toHaveBeenCalled();
    expect(ctx.findMember).not.toHaveBeenCalled();
  });

  it("warn_user rejects when caller lacks ModerateMembers — no DB write, no DM, no escalation", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.ModerateMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);

    const result = await executeMod("warn_user", { username: "victim", reason: "test" }, msg, ctx);

    expect(String(result)).toMatch(/can't warn/i);
    // The audit-flagged risk: warn_user could trigger auto-escalation ban.
    // Neither addWarning nor any escalation Discord API call may fire.
    expect(addWarning).not.toHaveBeenCalled();
    expect(ctx._target.ban).not.toHaveBeenCalled();
    expect(ctx._target.kick).not.toHaveBeenCalled();
    expect(ctx._target.timeout).not.toHaveBeenCalled();
    expect(ctx._target.send).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
    expect(ctx.findMember).not.toHaveBeenCalled();
  });

  it("timeout_user rejects when caller lacks ModerateMembers — no Discord call", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.ModerateMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);

    const result = await executeMod(
      "timeout_user",
      { username: "victim", duration: "1h", reason: "test" },
      msg,
      ctx,
    );

    expect(String(result)).toMatch(/can't timeout/i);
    expect(ctx._target.timeout).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
    expect(ctx.findMember).not.toHaveBeenCalled();
  });

  it("tempban rejects when caller lacks BanMembers — no DB write, no Discord ban", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.BanMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);

    const result = await executeMod(
      "tempban",
      { username: "victim", duration: "1h", reason: "test" },
      msg,
      ctx,
    );

    expect(String(result)).toMatch(/can't tempban/i);
    // tempban writes addTempBan(...) BEFORE the ban call — that's the exact
    // pre-fix vulnerability. Both must be silent.
    expect(addTempBan).not.toHaveBeenCalled();
    expect(ctx._target.ban).not.toHaveBeenCalled();
    expect(firePunishSignal).not.toHaveBeenCalled();
    expect(ctx.findMember).not.toHaveBeenCalled();
  });

  it("purge_messages rejects when caller lacks ManageMessages — channel.messages.fetch never runs", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.ManageMessages);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);
    const fetchSpy = vi.fn();
    msg.channel = { id: "channel-1", name: "general", messages: { fetch: fetchSpy }, send: vi.fn() } as any;

    const result = await executeMod("purge_messages", { count: 100 }, msg, ctx);

    expect(String(result)).toMatch(/can't purge/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("moderationExecutor — permission gate sits BEFORE side effects (regression guard)", () => {
  // These tests prove the per-perm check runs at the TOP of each handler.
  // If a future refactor moves an API call above the gate, findMember /
  // database / Discord spies will record it and these tests fail.

  it("ban_user does NOT call findMember before the perm check", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.BanMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);
    await executeMod("ban_user", { username: "anyone", reason: "x" }, msg, ctx);
    expect(ctx.findMember).not.toHaveBeenCalled();
    expect(ctx.checkHierarchy).not.toHaveBeenCalled();
  });

  it("tempban does NOT call addTempBan before the perm check", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.BanMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);
    await executeMod("tempban", { username: "anyone", duration: "1h", reason: "x" }, msg, ctx);
    expect(addTempBan).not.toHaveBeenCalled();
  });

  it("warn_user does NOT call addWarning before the perm check (would trigger auto-escalation)", async () => {
    const member = buildNonPermedMember(PermissionFlagsBits.ModerateMembers);
    const guild = buildFakeGuild();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild);
    await executeMod("warn_user", { username: "anyone", reason: "x" }, msg, ctx);
    expect(addWarning).not.toHaveBeenCalled();
  });
});
