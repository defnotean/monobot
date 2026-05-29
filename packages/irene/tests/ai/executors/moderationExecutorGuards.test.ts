// Regression tests for the destructive-Discord-call guards (resilience task 2):
//   member.kick() / member.timeout() / target.kick() can throw on a Discord
//   API failure (missing perms surfaced late, target left mid-action, rate
//   limit). Pre-fix those throws propagated uncaught out of the AI tool loop.
//   Post-fix they're caught, logged, and surfaced as a clear "Failed to ..."
//   string so the model can relay the failure to the user.
//
// Each test makes the relevant Discord op REJECT and asserts:
//   (a) execute()/commit() resolves (no uncaught throw),
//   (b) the returned message names the failure,
//   (c) downstream side effects (firePunishSignal, sendModLog) do NOT fire
//       after a failed action.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import {
  execute as executeMod,
  createPendingAction,
  consumePendingAction,
  commitPendingAction,
} from "../../../ai/executors/moderationExecutor.js";

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

import { logAudit } from "../../../database.js";
import { log, sendModLog } from "../../../utils/logger.js";
import { firePunishSignal } from "../../../utils/twinPunish.js";

// A member that HAS the given perm. id ≠ ownerId so the real perm check runs.
function buildPermedMember(perm: bigint, id = "mod-1") {
  return {
    id,
    permissions: { has: (p: bigint) => p === perm },
  };
}

function buildGuild() {
  return {
    id: "guild-1",
    ownerId: "owner-not-caller",
    name: "Test Guild",
    client: { user: { id: "bot-id" } },
  };
}

function buildMessage(member: any, guild: any) {
  return {
    member,
    author: { id: member.id, tag: "mod#0001", username: "mod" },
    client: guild.client,
    channel: { id: "channel-1", name: "general", send: vi.fn() },
    guild,
  };
}

// A target whose destructive op rejects. `op` selects which one throws.
function buildThrowingTarget(op: "kick" | "timeout", err = new Error("Missing Permissions")) {
  return {
    id: "victim-1",
    user: { id: "victim-1", tag: "victim#0001", username: "victim", createdTimestamp: 0 },
    bannable: true,
    nickname: null,
    joinedTimestamp: 0,
    isCommunicationDisabled: () => false,
    ban: vi.fn(async () => {}),
    kick: vi.fn(op === "kick" ? async () => { throw err; } : async () => {}),
    timeout: vi.fn(op === "timeout" ? async () => { throw err; } : async () => {}),
    roles: { cache: { has: () => false } },
  };
}

// Slash-equivalent ctx: no aiInitiated → inline path runs immediately
// (does not defer to a Confirm button).
function buildCtx(guild: any, target: any) {
  return {
    guild,
    by: "test",
    findChannel: vi.fn(),
    findMember: vi.fn(() => target),
    checkHierarchy: vi.fn(() => null),
    _target: target,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("destructive-call guards (resilience task 2)", () => {
  it("inline kick: a rejecting member.kick() is caught and surfaced, side effects skipped", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.KickMembers);
    const target = buildThrowingTarget("kick");
    const ctx = buildCtx(guild, target);

    // Must resolve (not reject) even though kick() throws.
    const result = await executeMod("kick_user", { username: "victim", reason: "spam" }, buildMessage(member, guild), ctx);

    expect(target.kick).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/Failed to kick/i);
    expect(String(result)).toContain("Missing Permissions");
    // No mod-log / punish-signal for an action that never landed.
    expect(sendModLog).not.toHaveBeenCalled();
    expect(firePunishSignal).not.toHaveBeenCalled();
    // The failure is observable in the log.
    expect(log).toHaveBeenCalled();
  });

  it("inline timeout: a rejecting member.timeout() is caught and surfaced, no mod-log", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ModerateMembers);
    const target = buildThrowingTarget("timeout");
    const ctx = buildCtx(guild, target);

    const result = await executeMod(
      "timeout_user",
      { username: "victim", duration: "1h", reason: "spam" },
      buildMessage(member, guild),
      ctx,
    );

    expect(target.timeout).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/Failed to timeout/i);
    expect(String(result)).toContain("Missing Permissions");
    expect(sendModLog).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("confirmed kick: a rejecting target.kick() returns { ok: false } instead of throwing", async () => {
    const guild = buildGuild();
    const target = buildThrowingTarget("kick");
    const taken = consumePendingAction(
      createPendingAction({
        action: "kick_user",
        input: { username: "victim", reason: "spam" },
        requiredPerm: PermissionFlagsBits.KickMembers,
      }),
    );

    const res = await commitPendingAction(taken, {
      guild,
      member: buildPermedMember(PermissionFlagsBits.KickMembers, "clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: { findMember: () => target, checkHierarchy: () => null, logAudit, firePunishSignal: () => Promise.resolve() },
    });

    expect(target.kick).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(String(res.message)).toMatch(/Failed to kick/i);
    // Confirmed kick must not log a success mod-log when the kick failed.
    expect(sendModLog).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("inline kick still succeeds (and runs side effects) on the happy path", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.KickMembers);
    // op="timeout" → kick() resolves normally.
    const target = buildThrowingTarget("timeout");
    const ctx = buildCtx(guild, target);

    const result = await executeMod("kick_user", { username: "victim", reason: "spam" }, buildMessage(member, guild), ctx);

    expect(target.kick).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/Kicked victim#0001/);
    expect(sendModLog).toHaveBeenCalledTimes(1);
  });
});
