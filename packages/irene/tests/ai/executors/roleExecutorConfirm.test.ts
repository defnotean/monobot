// Regression tests for the destructive-role-tool confirm gate (P2 #11):
//   (a) an AI-initiated delete_role / mass_role returns a pending-confirm
//       deferral (NOT an immediate mutation) backed by moderationExecutor's
//       pending-action store — mass_role defers BEFORE the full member fetch
//   (b) non-AI calls (no ctx.aiInitiated) still execute immediately
//   (c) a confirmed replay (ctx.confirmedAction) executes inline
//
// Mirrors moderationExecutorConfirm.test.ts / channelExecutorConfirm.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import { execute as executeRole } from "../../../ai/executors/roleExecutor.js";
// @ts-expect-error - importing JS module without types
import { getPendingAction } from "../../../ai/executors/moderationExecutor.js";
import { makeGuild, makeMember, makeRole, makeUser } from "../../_helpers/mockDiscord.js";

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
  getSupabase: vi.fn(() => null),
  getTrustedUsers: vi.fn(() => []),
}));

vi.mock("../../../utils/logger.js", () => ({
  log: vi.fn(),
  sendModLog: vi.fn(),
}));

vi.mock("../../../utils/twinPunish.js", () => ({
  firePunishSignal: vi.fn(async () => undefined),
}));

function buildHarness({ aiInitiated = false, confirmedAction = false }: any = {}) {
  const role = makeRole({ name: "Members", position: 1, delete: vi.fn(async () => {}) });

  const memberA = makeMember({ user: makeUser({ username: "alice", tag: "alice#0001" }) });
  const memberB = makeMember({ user: makeUser({ username: "bob", tag: "bob#0001" }) });

  const guild = makeGuild({ roles: [role], members: [memberA, memberB] });
  memberA.guild = guild;
  memberB.guild = guild;

  // Actor's top role sits above the target role so the real
  // checkRoleMutationHierarchy gate passes and we reach the confirm gate.
  const actor = makeMember({
    user: makeUser({ id: "actor-1", username: "actor", tag: "actor#0001" }),
    guild,
    permissions: [PermissionFlagsBits.ManageRoles],
    highestRolePosition: 10,
  });
  guild.members.cache.set(actor.id, actor);

  const message = {
    member: actor,
    author: actor.user,
    guild,
    client: { user: guild.members.me.user },
    channel: { id: "channel-1", name: "general", send: vi.fn() },
    content: "remove the Members role from everyone",
  };

  const ctx: any = {
    guild,
    by: "by test",
    findChannel: vi.fn(),
    findMember: vi.fn(),
    findRole: vi.fn((g: any, name: string) => g.roles.cache.find((r: any) => r.name.toLowerCase() === String(name).toLowerCase()) ?? null),
    parseHexColor: vi.fn(),
    checkRoleAssignment: vi.fn(() => null),
  };
  if (aiInitiated) ctx.aiInitiated = true;
  if (confirmedAction) ctx.confirmedAction = true;

  return { guild, role, memberA, memberB, message, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI-initiated destructive role tools defer to confirm", () => {
  it("delete_role returns a pending-confirm, NOT an immediate delete", async () => {
    const { role, message, ctx } = buildHarness({ aiInitiated: true });

    const result = await executeRole("delete_role", { name: "Members" }, message, ctx);

    expect((role as any).delete).not.toHaveBeenCalled();
    expect(result).toHaveProperty("components");
    expect(result).toHaveProperty("_pendingToken");
    expect(String(result.content)).toMatch(/moderator must confirm/i);

    const pending = getPendingAction(result._pendingToken);
    expect(pending).not.toBeNull();
    expect(pending.action).toBe("delete_role");
    expect(pending.requiredPerm).toBe(PermissionFlagsBits.ManageRoles);
    expect(pending.targetId).toBe(role.id);
  });

  it("mass_role returns a pending-confirm BEFORE the full member fetch — no role mutations", async () => {
    const { guild, memberA, memberB, message, ctx } = buildHarness({ aiInitiated: true });

    const result = await executeRole("mass_role", { role_name: "Members", action: "give" }, message, ctx);

    // Deferred before the expensive guild-wide fetch and before any mutation.
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(memberA.roles.add).not.toHaveBeenCalled();
    expect(memberB.roles.add).not.toHaveBeenCalled();
    expect(result).toHaveProperty("_pendingToken");
    expect(getPendingAction(result._pendingToken).action).toBe("mass_role");
  });

  it("non-AI delete_role (no aiInitiated flag) deletes immediately — manual path unchanged", async () => {
    const { role, message, ctx } = buildHarness();

    const result = await executeRole("delete_role", { name: "Members" }, message, ctx);

    expect((role as any).delete).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/deleted role "members"/i);
  });

  it("non-AI mass_role executes immediately", async () => {
    const { role, memberA, memberB, message, ctx } = buildHarness();

    const result = await executeRole("mass_role", { role_name: "Members", action: "give" }, message, ctx);

    // 3 = memberA + memberB + the actor (also a non-bot cache member).
    expect(memberA.roles.add).toHaveBeenCalledWith(role);
    expect(memberB.roles.add).toHaveBeenCalledWith(role);
    expect(String(result)).toMatch(/gave "members" to 3 members/i);
  });

  it("confirmed replay (ctx.confirmedAction) executes mass_role — the gate must not re-defer", async () => {
    // This is the contract commitPendingAction's replay uses: spread the stashed
    // ctx + confirmedAction:true and re-call the executor.
    const { memberA, memberB, message, ctx } = buildHarness({ aiInitiated: true, confirmedAction: true });

    const result = await executeRole("mass_role", { role_name: "Members", action: "give" }, message, ctx);

    expect(memberA.roles.add).toHaveBeenCalledTimes(1);
    expect(memberB.roles.add).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/gave "members" to 3 members/i);
  });

  it("confirmed replay (ctx.confirmedAction) executes delete_role without re-deferring", async () => {
    const { role, message, ctx } = buildHarness({ aiInitiated: true, confirmedAction: true });

    const result = await executeRole("delete_role", { name: "Members" }, message, ctx);

    expect((role as any).delete).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("_pendingToken");
    expect(String(result)).toMatch(/deleted role "members"/i);
  });
});
