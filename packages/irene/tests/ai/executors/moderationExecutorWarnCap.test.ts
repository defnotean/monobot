// Regression test for AUDIT-irene-moderation.md risk #4:
//   The AI `warn_user` tool path must NEVER auto-ban or auto-kick, even
//   when the server's escalation config says it should. A single LLM
//   hallucination producing `warn_user` on a user already at
//   `ban_at - 1` would otherwise permanently ban that user with zero
//   confirmation. The fix in moderationExecutor.js caps the AI path at
//   a 24h timeout for the would-be-ban / would-be-kick tiers; BAN and
//   KICK on warn-threshold are now slash-command-only.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so they're applied before the SUT imports them.
const mockState = vi.hoisted(() => ({
  warningCount: 0,
  escalation: { mute_at: null as number | null, kick_at: null as number | null, ban_at: null as number | null },
}));

vi.mock("../../../database.js", () => ({
  addWarning: vi.fn(() => ({ id: 42 })),
  // The executor calls getWarnings AFTER addWarning, so the returned
  // length represents post-addition state. We let the test set it.
  getWarnings: vi.fn(() => Array.from({ length: mockState.warningCount }, (_, i) => ({ id: i + 1 }))),
  deleteWarning: vi.fn(),
  clearWarnings: vi.fn(),
  logAudit: vi.fn(),
  removeTempBan: vi.fn(),
  getGuildSettings: vi.fn(() => ({})),
  getEscalation: vi.fn(() => mockState.escalation),
}));

vi.mock("../../../utils/logger.js", () => ({
  sendModLog: vi.fn(async () => {}),
  log: vi.fn(),
}));

vi.mock("../../../utils/embeds.js", () => ({
  modEmbed: vi.fn(() => ({ setDescription: () => ({}) })),
  logEvent: vi.fn((args: any) => ({ kind: args?.kind, meta: args?.meta })),
  buildUndoRow: vi.fn(() => null),
}));

vi.mock("../../../utils/twinPunish.js", () => ({
  firePunishSignal: vi.fn(async () => {}),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/moderationExecutor.js";

function makeCtx(member: any) {
  const guild = { id: "g1", name: "Test Guild", ownerId: "owner1", members: { ban: vi.fn() } };
  return {
    ctx: {
      guild,
      by: { id: "mod1" },
      findChannel: vi.fn(),
      findMember: vi.fn(() => member),
      checkHierarchy: vi.fn(() => null), // no hierarchy error
    },
    message: {
      author: { id: "mod1", tag: "Mod#0001", username: "Mod" },
      client: { user: { id: "bot1" } },
      member: { id: "mod1", permissions: { has: () => true } },
    },
    guild,
  };
}

function makeMember() {
  return {
    id: "victim1",
    nickname: null,
    user: { id: "victim1", tag: "Victim#0001", username: "Victim", createdTimestamp: 0 },
    ban: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    timeout: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
}

describe("warn_user AI-path escalation cap (audit risk #4)", () => {
  beforeEach(() => {
    mockState.warningCount = 0;
    mockState.escalation = { mute_at: null, kick_at: null, ban_at: null };
  });

  it("does NOT call member.ban() even when warn count is at the ban tier", async () => {
    // Server policy: ban at 3 warnings. AI issues the 3rd warning.
    mockState.escalation = { mute_at: null, kick_at: null, ban_at: 3 };
    mockState.warningCount = 3;

    const member = makeMember();
    const { ctx, message } = makeCtx(member);

    const result = await execute("warn_user", { username: "Victim", reason: "spam" }, message, ctx);

    // The critical assertion — no silent auto-ban from AI tool call.
    expect(member.ban).not.toHaveBeenCalled();
    expect(member.kick).not.toHaveBeenCalled();
    // Instead the AI path caps at a 24h timeout.
    expect(member.timeout).toHaveBeenCalledTimes(1);
    const [durationMs] = member.timeout.mock.calls[0];
    expect(durationMs).toBe(24 * 60 * 60_000);
    // And the result string explains the cap so the mod knows action is needed.
    expect(String(result)).toContain("would-be ban requires mod action");
  });

  it("does NOT call member.kick() even when warn count is at the kick tier", async () => {
    // Server policy: kick at 2, no ban configured. AI issues the 2nd warning.
    mockState.escalation = { mute_at: null, kick_at: 2, ban_at: null };
    mockState.warningCount = 2;

    const member = makeMember();
    const { ctx, message } = makeCtx(member);

    const result = await execute("warn_user", { username: "Victim", reason: "spam" }, message, ctx);

    expect(member.ban).not.toHaveBeenCalled();
    expect(member.kick).not.toHaveBeenCalled();
    expect(member.timeout).toHaveBeenCalledTimes(1);
    expect(member.timeout.mock.calls[0][0]).toBe(24 * 60 * 60_000);
    expect(String(result)).toContain("would-be kick requires mod action");
  });

  it("ban tier takes precedence over kick/mute when multiple thresholds cross", async () => {
    // All three thresholds crossed simultaneously. Ban tier wins, but is
    // still capped to a 24h timeout, NOT an actual ban.
    mockState.escalation = { mute_at: 1, kick_at: 2, ban_at: 3 };
    mockState.warningCount = 5;

    const member = makeMember();
    const { ctx, message } = makeCtx(member);

    await execute("warn_user", { username: "Victim", reason: "spam" }, message, ctx);

    expect(member.ban).not.toHaveBeenCalled();
    expect(member.kick).not.toHaveBeenCalled();
    expect(member.timeout).toHaveBeenCalledTimes(1);
    expect(member.timeout.mock.calls[0][0]).toBe(24 * 60 * 60_000);
  });

  it("mute tier still triggers a 10m timeout (un-capped low-tier escalation works)", async () => {
    // Only mute_at configured. The cap only kicks in for would-be-ban /
    // would-be-kick; the mute tier still produces a 10m timeout as before.
    mockState.escalation = { mute_at: 2, kick_at: null, ban_at: null };
    mockState.warningCount = 2;

    const member = makeMember();
    const { ctx, message } = makeCtx(member);

    await execute("warn_user", { username: "Victim", reason: "spam" }, message, ctx);

    expect(member.ban).not.toHaveBeenCalled();
    expect(member.kick).not.toHaveBeenCalled();
    expect(member.timeout).toHaveBeenCalledTimes(1);
    expect(member.timeout.mock.calls[0][0]).toBe(10 * 60_000);
  });

  it("below all thresholds: no escalation action at all", async () => {
    mockState.escalation = { mute_at: 5, kick_at: 7, ban_at: 10 };
    mockState.warningCount = 1;

    const member = makeMember();
    const { ctx, message } = makeCtx(member);

    await execute("warn_user", { username: "Victim", reason: "spam" }, message, ctx);

    expect(member.ban).not.toHaveBeenCalled();
    expect(member.kick).not.toHaveBeenCalled();
    expect(member.timeout).not.toHaveBeenCalled();
  });
});
