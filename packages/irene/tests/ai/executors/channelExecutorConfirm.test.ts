// Regression tests for the destructive-channel-tool confirm gate (P2 #11):
//   (a) an AI-initiated delete_channel / nuke_channel returns a pending-confirm
//       deferral (NOT an immediate delete) backed by moderationExecutor's
//       pending-action store
//   (b) non-AI calls (no ctx.aiInitiated — slash-equivalent/manual paths)
//       still execute immediately, unchanged
//   (c) a confirmed replay (ctx.confirmedAction, what commitPendingAction sets
//       when a permitted human clicks Confirm) executes inline — the gate must
//       not re-defer
//
// Mirrors moderationExecutorConfirm.test.ts, which covers the same gate for
// ban/kick/tempban/purge.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import { execute as executeChannel } from "../../../ai/executors/channelExecutor.js";
// @ts-expect-error - importing JS module without types
import { getPendingAction } from "../../../ai/executors/moderationExecutor.js";
import { makeChannel, makeGuild, makeMember, makeUser } from "../../_helpers/mockDiscord.js";

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

// @ts-expect-error - importing JS module without types
import { logAudit } from "../../../database.js";

function buildHarness({ aiInitiated = false, confirmedAction = false }: any = {}) {
  const clone = makeChannel({ name: "general" });
  (clone as any).setPosition = vi.fn(async () => {});
  const targetChannel = makeChannel({ name: "general", position: 3 });
  (targetChannel as any).clone = vi.fn(async () => clone);

  const guild = makeGuild({ channels: [targetChannel] });
  targetChannel.guild = guild;

  const actor = makeMember({
    user: makeUser({ id: "actor-1", username: "actor", tag: "actor#0001" }),
    guild,
    permissions: [PermissionFlagsBits.ManageChannels],
  });
  guild.members.cache.set(actor.id, actor);

  const message = {
    member: actor,
    author: actor.user,
    guild,
    client: { user: guild.members.me.user },
    channel: targetChannel,
    content: "delete the general channel",
  };

  const ctx: any = {
    guild,
    by: "by test",
    findChannel: vi.fn((g: any, name: string) => g.channels.cache.find((c: any) => c.name.toLowerCase() === String(name).toLowerCase()) ?? null),
    findMember: vi.fn(),
    findRole: vi.fn(),
  };
  if (aiInitiated) ctx.aiInitiated = true;
  if (confirmedAction) ctx.confirmedAction = true;

  return { guild, targetChannel, clone, message, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI-initiated destructive channel tools defer to confirm", () => {
  it("delete_channel returns a pending-confirm, NOT an immediate delete", async () => {
    const { targetChannel, message, ctx } = buildHarness({ aiInitiated: true });

    const result = await executeChannel("delete_channel", { name: "general" }, message, ctx);

    expect(targetChannel.delete).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(result).toHaveProperty("components");
    expect(result).toHaveProperty("_pendingToken");
    expect(String(result.content)).toMatch(/moderator must confirm/i);

    // The stored action is retrievable from the shared pending store and
    // carries the right perm for the click-time re-check.
    const pending = getPendingAction(result._pendingToken);
    expect(pending).not.toBeNull();
    expect(pending.action).toBe("delete_channel");
    expect(pending.requiredPerm).toBe(PermissionFlagsBits.ManageChannels);
    expect(pending.targetId).toBe(targetChannel.id);
  });

  it("nuke_channel returns a pending-confirm — no clone, no delete", async () => {
    const { targetChannel, message, ctx } = buildHarness({ aiInitiated: true });

    const result = await executeChannel("nuke_channel", { channel_name: "general" }, message, ctx);

    expect((targetChannel as any).clone).not.toHaveBeenCalled();
    expect(targetChannel.delete).not.toHaveBeenCalled();
    expect(result).toHaveProperty("_pendingToken");
    expect(getPendingAction(result._pendingToken).action).toBe("nuke_channel");
  });

  it("non-AI delete_channel (no aiInitiated flag) deletes immediately — manual path unchanged", async () => {
    const { guild, targetChannel, message, ctx } = buildHarness();

    const result = await executeChannel("delete_channel", { name: "general" }, message, ctx);

    expect(targetChannel.delete).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(guild.id, "delete_channel", "actor-1", "general");
    expect(String(result)).toMatch(/deleted channel #general/i);
  });

  it("non-AI nuke_channel executes immediately", async () => {
    const { targetChannel, clone, message, ctx } = buildHarness();

    const result = await executeChannel("nuke_channel", { channel_name: "general" }, message, ctx);

    expect((targetChannel as any).clone).toHaveBeenCalledTimes(1);
    expect(targetChannel.delete).toHaveBeenCalledTimes(1);
    expect(clone.send).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/nuked #general/i);
  });

  it("confirmed replay (ctx.confirmedAction) executes delete_channel — the gate must not re-defer", async () => {
    // This is the contract commitPendingAction's replay uses: spread the stashed
    // ctx + confirmedAction:true and re-call the executor.
    const { targetChannel, message, ctx } = buildHarness({ aiInitiated: true, confirmedAction: true });

    const result = await executeChannel("delete_channel", { name: "general" }, message, ctx);

    expect(targetChannel.delete).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/deleted channel #general/i);
  });

  it("confirmed replay (ctx.confirmedAction) executes nuke_channel without re-deferring", async () => {
    const { targetChannel, clone, message, ctx } = buildHarness({ aiInitiated: true, confirmedAction: true });

    const result = await executeChannel("nuke_channel", { channel_name: "general" }, message, ctx);

    expect((targetChannel as any).clone).toHaveBeenCalledTimes(1);
    expect((clone as any).setPosition).toHaveBeenCalledWith(targetChannel.position);
    expect(targetChannel.delete).toHaveBeenCalledTimes(1);
    expect(clone.send).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("_pendingToken");
    expect(String(result)).toMatch(/nuked #general/i);
  });
});
