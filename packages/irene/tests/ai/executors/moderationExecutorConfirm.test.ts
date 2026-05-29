// Regression tests for the moderation authz + destructive-action confirmation
// hardening:
//   (a) lockdown_server / snipe refuse without ManageChannels / ManageMessages
//   (b) an AI-initiated ban returns a pending-confirm (NOT an immediate ban),
//       and the stored action commits only on a permitted click
//   (c) a purge of 51 requires confirm; a purge of 10 runs inline
//
// The confirm gate keys off `ctx.aiInitiated`. Calls WITHOUT that flag execute
// immediately (mirrors the slash-command-equivalent path and preserves the
// existing warn-cap test behavior).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import {
  execute as executeMod,
  createPendingAction,
  getPendingAction,
  consumePendingAction,
  commitPendingAction,
  buildConfirmRow,
  PURGE_CONFIRM_THRESHOLD,
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

import { addTempBan, logAudit } from "../../../database.js";
import { sendModLog } from "../../../utils/logger.js";

// A member that HAS the given perm (mod). id ≠ ownerId so we exercise the real
// permission check, not the owner short-circuit.
function buildPermedMember(perm: bigint, id = "mod-1") {
  return {
    id,
    permissions: {
      has: (p: bigint) => p === perm || p === PermissionFlagsBits.Administrator ? p === perm : false,
    },
  };
}

// A member lacking everything (used to prove confirm refuses unpermitted clicks
// and the authz gates reject).
function buildNonPermedMember(id = "rando-1") {
  return { id, permissions: { has: () => false } };
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

function buildTarget(extra: Record<string, any> = {}) {
  return {
    id: "victim-1",
    user: { id: "victim-1", tag: "victim#0001", username: "victim", createdTimestamp: 0 },
    bannable: true,
    nickname: null,
    joinedTimestamp: 0,
    ban: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    roles: { cache: { has: () => false } },
    ...extra,
  };
}

function buildCtx(guild: any, target: any, extra: Record<string, any> = {}) {
  return {
    guild,
    by: "test",
    findChannel: vi.fn(),
    findMember: vi.fn(() => target),
    checkHierarchy: vi.fn(() => null),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authz gates at point of effect (Task 1)", () => {
  it("lockdown_server refuses without ManageChannels", async () => {
    const guild = buildGuild();
    const msg = buildMessage(buildNonPermedMember(), guild);
    const ctx = buildCtx(guild, buildTarget());
    const result = await executeMod("lockdown_server", { reason: "x" }, msg, ctx);
    expect(String(result)).toMatch(/can't lock down/i);
  });

  it("unlock_server refuses without ManageChannels", async () => {
    const guild = buildGuild();
    const msg = buildMessage(buildNonPermedMember(), guild);
    const ctx = buildCtx(guild, buildTarget());
    const result = await executeMod("unlock_server", { reason: "x" }, msg, ctx);
    expect(String(result)).toMatch(/can't unlock/i);
  });

  it("find_message refuses without ManageMessages — no channel scan", async () => {
    const guild = buildGuild();
    const msg = buildMessage(buildNonPermedMember(), guild);
    const ctx = buildCtx(guild, buildTarget());
    const result = await executeMod("find_message", { contains: "secret" }, msg, ctx);
    expect(String(result)).toMatch(/can't search/i);
    expect(ctx.findChannel).not.toHaveBeenCalled();
  });

  it("snipe refuses without ManageMessages — no message exfil", async () => {
    const guild = buildGuild();
    const msg = buildMessage(buildNonPermedMember(), guild);
    const ctx = buildCtx(guild, buildTarget());
    const result = await executeMod("snipe", { index: 1 }, msg, ctx);
    expect(String(result)).toMatch(/can't snipe deleted/i);
    expect(msg.channel.send).not.toHaveBeenCalled();
  });

  it("editsnipe refuses without ManageMessages", async () => {
    const guild = buildGuild();
    const msg = buildMessage(buildNonPermedMember(), guild);
    const ctx = buildCtx(guild, buildTarget());
    const result = await executeMod("editsnipe", { index: 1 }, msg, ctx);
    expect(String(result)).toMatch(/can't snipe edited/i);
    expect(msg.channel.send).not.toHaveBeenCalled();
  });
});

describe("AI-initiated destructive actions defer to confirm (Task 2)", () => {
  it("AI-initiated ban returns a pending-confirm, NOT an immediate ban", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers);
    const msg = buildMessage(member, guild);
    const target = buildTarget();
    const ctx = buildCtx(guild, target, { aiInitiated: true });

    const result = await executeMod("ban_user", { username: "victim", reason: "spam" }, msg, ctx);

    // No ban happened — instead a confirm payload came back.
    expect(target.ban).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(result).toHaveProperty("components");
    expect(result).toHaveProperty("_pendingToken");
    expect(String(result.content)).toMatch(/moderator must confirm/i);

    // The stored action is retrievable and commits only on a permitted click.
    const pending = getPendingAction(result._pendingToken);
    expect(pending).not.toBeNull();
    expect(pending.action).toBe("ban_user");

    // Unpermitted clicker: commit refuses, no ban.
    const refused = await commitPendingAction(pending, {
      guild,
      member: buildNonPermedMember("not-a-mod"),
      clickedBy: { id: "not-a-mod" },
      deps: { findMember: () => target, checkHierarchy: () => null, logAudit, firePunishSignal: () => Promise.resolve() },
    });
    expect(refused.ok).toBe(false);
    expect(target.ban).not.toHaveBeenCalled();

    // Permitted clicker: the ban now actually fires.
    const taken = consumePendingAction(result._pendingToken);
    const ok = await commitPendingAction(taken, {
      guild,
      member: buildPermedMember(PermissionFlagsBits.BanMembers, "clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: { findMember: () => target, checkHierarchy: () => null, logAudit, firePunishSignal: () => Promise.resolve() },
    });
    expect(ok.ok).toBe(true);
    expect(target.ban).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(guild.id, "ban", "clicker-mod", "victim");
  });

  it("a NON-AI ban (no aiInitiated flag) bans immediately — slash-equivalent path unchanged", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers);
    const msg = buildMessage(member, guild);
    const target = buildTarget();
    const ctx = buildCtx(guild, target); // no aiInitiated

    const result = await executeMod("ban_user", { username: "victim", reason: "spam" }, msg, ctx);

    expect(target.ban).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/banned/i);
  });

  it("inline ban refuses non-bannable targets before Discord/audit side effects", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers);
    const msg = buildMessage(member, guild);
    const target = buildTarget({ bannable: false });
    const ctx = buildCtx(guild, target);

    const result = await executeMod("ban_user", { username: "victim", reason: "spam" }, msg, ctx);

    expect(String(result)).toMatch(/can't ban/i);
    expect(target.ban).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("inline tempban does not write temp-ban state if Discord rejects the ban", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers);
    const msg = buildMessage(member, guild);
    const target = buildTarget({ ban: vi.fn(async () => { throw new Error("missing permissions"); }) });
    const ctx = buildCtx(guild, target);

    const result = await executeMod("tempban", { username: "victim", duration: "1h", reason: "spam" }, msg, ctx);

    expect(String(result)).toMatch(/failed to ban/i);
    expect(target.ban).toHaveBeenCalledTimes(1);
    expect(addTempBan).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("AI-initiated kick defers; AI tempban defers", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.KickMembers);
    const target = buildTarget();

    const kickCtx = buildCtx(guild, target, { aiInitiated: true });
    const kickRes = await executeMod("kick_user", { username: "victim" }, buildMessage(member, guild), kickCtx);
    expect(target.kick).not.toHaveBeenCalled();
    expect(kickRes).toHaveProperty("_pendingToken");

    const banMember = buildPermedMember(PermissionFlagsBits.BanMembers);
    const tbCtx = buildCtx(guild, target, { aiInitiated: true });
    const tbRes = await executeMod("tempban", { username: "victim", duration: "1d" }, buildMessage(banMember, guild), tbCtx);
    expect(target.ban).not.toHaveBeenCalled();
    expect(tbRes).toHaveProperty("_pendingToken");
    const tbPending = getPendingAction(tbRes._pendingToken);
    expect(tbPending.action).toBe("tempban");
    expect(tbPending.durationStr).toBe("1d");
  });

  it("confirmed ban refuses non-bannable targets and keeps logs/audit silent", async () => {
    const guild = buildGuild();
    const target = buildTarget({ bannable: false });
    const token = createPendingAction({
      action: "ban_user",
      input: { username: "victim", reason: "spam" },
      requiredPerm: PermissionFlagsBits.BanMembers,
      targetId: target.id,
      summary: "Ban victim",
    });
    const pending = consumePendingAction(token);

    const result = await commitPendingAction(pending, {
      guild,
      member: buildPermedMember(PermissionFlagsBits.BanMembers, "clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: { findMember: () => target, checkHierarchy: () => null, logAudit, firePunishSignal: () => Promise.resolve() },
    });

    expect(result.ok).toBe(false);
    expect(String(result.message)).toMatch(/can't ban/i);
    expect(target.ban).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("a confirmed ban/kick emits the same mod-log as the inline path", () => {
  // Regression: commitPendingAction's ban/kick paths previously skipped the
  // sendModLog embed + buildUndoRow that the inline ban/kick cases emit, so a
  // button-confirmed ban/kick left NO mod-log entry and NO undo button.
  function buildSnowflakeTarget(id = "123456789012345678") {
    return {
      id,
      user: { id, tag: "victim#0001", username: "victim", createdTimestamp: 0 },
      bannable: true,
      nickname: null,
      joinedTimestamp: 0,
      ban: vi.fn(async () => {}),
      kick: vi.fn(async () => {}),
      roles: { cache: { has: () => false } },
    };
  }

  it("confirmed ban logs a 'ban' mod-log with an undo row", async () => {
    const guild = buildGuild();
    const target = buildSnowflakeTarget();
    const taken = consumePendingAction(
      createPendingAction({
        action: "ban_user",
        input: { username: "victim", reason: "spam" },
        requiredPerm: PermissionFlagsBits.BanMembers,
      }),
    );
    const ok = await commitPendingAction(taken, {
      guild,
      member: buildPermedMember(PermissionFlagsBits.BanMembers, "clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: { findMember: () => target, checkHierarchy: () => null, logAudit, firePunishSignal: () => Promise.resolve() },
    });

    expect(ok.ok).toBe(true);
    expect(target.ban).toHaveBeenCalledTimes(1);
    // Mod-log entry now exists (previously skipped on the confirm path).
    expect(sendModLog).toHaveBeenCalledTimes(1);
    const payload = (sendModLog as any).mock.calls[0][1];
    expect(payload.embed).toBeTruthy();
    // Undo row is present (snowflake-shaped id passes buildUndoRow's guard).
    expect(payload.components).toHaveLength(1);
  });

  it("confirmed kick logs a 'kick' mod-log embed", async () => {
    const guild = buildGuild();
    const target = buildSnowflakeTarget();
    const taken = consumePendingAction(
      createPendingAction({
        action: "kick_user",
        input: { username: "victim", reason: "spam" },
        requiredPerm: PermissionFlagsBits.KickMembers,
      }),
    );
    const ok = await commitPendingAction(taken, {
      guild,
      member: buildPermedMember(PermissionFlagsBits.KickMembers, "clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: { findMember: () => target, checkHierarchy: () => null, logAudit, firePunishSignal: () => Promise.resolve() },
    });

    expect(ok.ok).toBe(true);
    expect(target.kick).toHaveBeenCalledTimes(1);
    expect(sendModLog).toHaveBeenCalledTimes(1);
  });
});

describe("purge confirmation threshold (Task 2c)", () => {
  it("AI purge of 51 requires confirm", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ManageMessages);
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild, buildTarget(), { aiInitiated: true });
    // No messages.fetch should be hit — the gate returns before the channel work.
    const fetchSpy = vi.fn();
    msg.channel = { id: "channel-1", name: "general", messages: { fetch: fetchSpy }, send: vi.fn() } as any;

    const result = await executeMod("purge_messages", { count: 51 }, msg, ctx);
    expect(result).toHaveProperty("_pendingToken");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPendingAction(result._pendingToken).action).toBe("purge_messages");
    expect(PURGE_CONFIRM_THRESHOLD).toBe(50);
  });

  it("AI purge of 10 does NOT require confirm — runs inline", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ManageMessages);
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild, buildTarget(), { aiInitiated: true });
    // Empty fetch → executor returns "No messages found." but PROVES it got
    // past the confirm gate into the real purge path.
    const fetchSpy = vi.fn(async () => ({ size: 0, values: () => [], last: () => undefined }));
    msg.channel = { id: "channel-1", name: "general", messages: { fetch: fetchSpy }, send: vi.fn() } as any;

    const result = await executeMod("purge_messages", { count: 10 }, msg, ctx);
    expect(typeof result).toBe("string");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("pending-action store internals", () => {
  it("getPendingAction returns null after consume (one-shot)", () => {
    const token = createPendingAction({ action: "ban_user", input: {}, requiredPerm: PermissionFlagsBits.BanMembers });
    expect(getPendingAction(token)).not.toBeNull();
    expect(consumePendingAction(token)).not.toBeNull();
    expect(getPendingAction(token)).toBeNull();
    expect(consumePendingAction(token)).toBeNull();
  });

  it("buildConfirmRow uses the modconfirm:/modcancel: customId convention", () => {
    const token = "abcd1234";
    const row = buildConfirmRow(token) as any;
    const ids = row.components.map((c: any) => c.data.custom_id);
    expect(ids).toContain(`modconfirm:${token}`);
    expect(ids).toContain(`modcancel:${token}`);
  });
});
