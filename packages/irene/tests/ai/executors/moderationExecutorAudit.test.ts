// Regression tests for the durable moderation audit trail (irene_mod_audit).
//
// The mod audit was a 100-entry in-memory ring (database.js#logAudit) wiped on
// restart and skipping several destructive tools. moderationExecutor.js now
// ALSO appends every action to a durable Supabase table, best-effort and
// fire-and-forget. These tests cover:
//   (a) a ban writes an audit row with the right fields and source
//   (b) an AI-confirmed action records actor=confirming-human AND the original
//       natural-language instruction ("ban the spammer")
//   (c) an audit write failure does not throw / does not block the action
//
// We mock database.js#getSupabase to hand the executor a fake client whose
// .insert() records rows into an in-memory array (or fails on demand).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";

// Hoisted so the fake Supabase + its captured rows exist before the SUT imports
// database.js (which we mock).
const sb = vi.hoisted(() => {
  const rows: any[] = [];
  // insertBehavior: "ok" → resolves { error: null }; "schema-missing" → resolves
  // a 42P01 error; "throw" → the insert() call itself rejects.
  const state = { insertBehavior: "ok" as "ok" | "schema-missing" | "throw", client: null as any };

  function makeClient() {
    return {
      from(table: string) {
        if (table !== "irene_mod_audit") {
          throw new Error(`fakeSupabase: unexpected table "${table}"`);
        }
        return {
          insert(row: any) {
            if (state.insertBehavior === "throw") {
              return Promise.reject(new Error("connection reset"));
            }
            if (state.insertBehavior === "schema-missing") {
              return Promise.resolve({ error: { code: "42P01", message: 'relation "irene_mod_audit" does not exist' } });
            }
            rows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  }
  state.client = makeClient();
  return { rows, state };
});

vi.mock("../../../database.js", () => ({
  addWarning: vi.fn(() => ({ id: 7 })),
  getWarnings: vi.fn(() => []),
  deleteWarning: vi.fn(),
  clearWarnings: vi.fn(),
  logAudit: vi.fn(),
  removeTempBan: vi.fn(),
  getGuildSettings: vi.fn(() => ({})),
  getEscalation: vi.fn(() => ({ ban_at: null, kick_at: null, mute_at: null })),
  addTempBan: vi.fn(),
  getSupabase: () => sb.state.client,
}));

vi.mock("../../../utils/logger.js", () => ({
  log: vi.fn(),
  sendModLog: vi.fn(async () => {}),
}));

vi.mock("../../../utils/twinPunish.js", () => ({
  firePunishSignal: vi.fn(async () => undefined),
}));

// @ts-expect-error - importing JS module without types
import {
  execute as executeMod,
  commitPendingAction,
  createPendingAction,
  consumePendingAction,
  _resetAuditForTest,
} from "../../../ai/executors/moderationExecutor.js";
import { log } from "../../../utils/logger.js";
import {
  deleteWarning,
  clearWarnings,
  getWarnings,
  getGuildSettings,
} from "../../../database.js";

// A member that HAS the given perm. id ≠ ownerId so the real perm check runs.
function buildPermedMember(perm: bigint, id = "mod-1") {
  return { id, permissions: { has: (p: bigint) => p === perm } };
}

function buildGuild() {
  return {
    id: "guild-1",
    ownerId: "owner-not-caller",
    name: "Test Guild",
    client: { user: { id: "bot-id" } },
  };
}

function buildTarget(id = "victim-1") {
  return {
    id,
    user: { id, tag: "victim#0001", username: "victim", createdTimestamp: 0 },
    bannable: true,
    nickname: null,
    joinedTimestamp: 0,
    ban: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    timeout: vi.fn(async () => {}),
    roles: { cache: { has: () => false } },
  };
}

// content carries the original natural-language instruction on the AI path.
function buildMessage(member: any, guild: any, content?: string) {
  return {
    member,
    author: { id: member.id, tag: "mod#0001", username: "mod" },
    client: guild.client,
    channel: { id: "channel-1", name: "general", send: vi.fn() },
    guild,
    content,
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

// writeModAudit is fire-and-forget: it kicks off Promise.resolve().then(insert)
// .then(handler). Flush a few microtask turns so the insert and its handler run.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  sb.rows.length = 0;
  sb.state.insertBehavior = "ok";
  _resetAuditForTest();
});

describe("durable mod audit — (a) a ban writes an audit row with the right fields", () => {
  it("a non-AI (slash-equivalent) ban writes one audit row: action=ban, source=slash, actor/target/reason set", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers, "mod-actor");
    const target = buildTarget("victim-9");
    const msg = buildMessage(member, guild); // no content, no aiInitiated → slash
    const ctx = buildCtx(guild, target); // no aiInitiated

    const result = await executeMod("ban_user", { username: "victim", reason: "spamming links" }, msg, ctx);
    expect(target.ban).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/banned/i);

    await flush();
    expect(sb.rows).toHaveLength(1);
    const row = sb.rows[0];
    expect(row.guild_id).toBe("guild-1");
    expect(row.actor_id).toBe("mod-actor");
    expect(row.target_id).toBe("victim-9");
    expect(row.action).toBe("ban");
    expect(row.reason).toBe("spamming links");
    expect(row.source).toBe("slash");
    // No AI instruction on the slash path.
    expect(row.instruction).toBeNull();
    expect(typeof row.ts).toBe("string");
  });

  it("an AI-initiated timeout writes source=ai-tool and captures the instruction", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ModerateMembers, "mod-actor");
    const target = buildTarget("victim-7");
    const msg = buildMessage(member, guild, "mute the troll for an hour");
    const ctx = buildCtx(guild, target, { aiInitiated: true });

    await executeMod("timeout_user", { username: "victim", duration: "1h", reason: "trolling" }, msg, ctx);

    await flush();
    expect(sb.rows).toHaveLength(1);
    const row = sb.rows[0];
    expect(row.action).toBe("timeout");
    expect(row.source).toBe("ai-tool");
    expect(row.actor_id).toBe("mod-actor");
    expect(row.target_id).toBe("victim-7");
    expect(row.instruction).toBe("mute the troll for an hour");
  });
});

describe("durable mod audit — (b) AI-confirmed action: actor is confirming human + original instruction", () => {
  it("a confirmed ban records actor=clickedBy, source=ai-tool-confirmed, instruction='ban the spammer'", async () => {
    const guild = buildGuild();
    const target = buildTarget("123456789012345678");

    // Defer: an AI-initiated ban returns a pending-confirm and writes NO audit
    // row yet (the ban hasn't committed).
    const requester = buildPermedMember(PermissionFlagsBits.BanMembers, "requester-mod");
    const deferMsg = buildMessage(requester, guild, "ban the spammer");
    const deferCtx = buildCtx(guild, target, { aiInitiated: true });
    const deferred = await executeMod("ban_user", { username: "victim", reason: "spam" }, deferMsg, deferCtx);
    expect(deferred).toHaveProperty("_pendingToken");
    await flush();
    expect(sb.rows).toHaveLength(0); // nothing committed → nothing audited yet

    // A DIFFERENT human clicks Confirm.
    const taken = consumePendingAction((deferred as any)._pendingToken);
    const ok = await commitPendingAction(taken, {
      guild,
      member: buildPermedMember(PermissionFlagsBits.BanMembers, "clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: {
        findMember: () => target,
        checkHierarchy: () => null,
        logAudit: vi.fn(),
        firePunishSignal: () => Promise.resolve(),
      },
    });
    expect(ok.ok).toBe(true);
    expect(target.ban).toHaveBeenCalledTimes(1);

    await flush();
    expect(sb.rows).toHaveLength(1);
    const row = sb.rows[0];
    expect(row.action).toBe("ban");
    expect(row.source).toBe("ai-tool-confirmed");
    // Actor is the confirming human, NOT the requester who asked the AI.
    expect(row.actor_id).toBe("clicker-mod");
    expect(row.target_id).toBe("123456789012345678");
    // The original NL instruction is preserved end-to-end.
    expect(row.instruction).toBe("ban the spammer");
  });
});

describe("durable mod audit — (c) audit write failure never throws / never blocks the action", () => {
  it("an insert that REJECTS does not throw and the ban still succeeds", async () => {
    sb.state.insertBehavior = "throw";
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers, "mod-actor");
    const target = buildTarget();
    const msg = buildMessage(member, guild);
    const ctx = buildCtx(guild, target);

    // The action returns its normal success string; the rejected audit insert
    // is swallowed by writeModAudit's .catch.
    const result = await executeMod("ban_user", { username: "victim", reason: "x" }, msg, ctx);
    expect(String(result)).toMatch(/banned/i);
    expect(target.ban).toHaveBeenCalledTimes(1);

    await flush();
    // No row recorded (insert rejected), but nothing threw.
    expect(sb.rows).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  it("a missing table (42P01) logs once, degrades, and stops hammering Supabase", async () => {
    sb.state.insertBehavior = "schema-missing";
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.BanMembers, "mod-actor");
    const target = buildTarget();
    const ctx = buildCtx(guild, target);

    await executeMod("ban_user", { username: "victim", reason: "x" }, buildMessage(member, guild), ctx);
    await flush();
    const firstLogCount = (log as any).mock.calls.length;
    expect(firstLogCount).toBeGreaterThanOrEqual(1);

    // Switch the fake back to OK — but because the executor degraded after the
    // schema-missing error, it must NOT attempt another insert.
    sb.state.insertBehavior = "ok";
    await executeMod("kick_user", { username: "victim", reason: "x" }, buildMessage(buildPermedMember(PermissionFlagsBits.KickMembers, "mod-actor"), guild), buildCtx(guild, target));
    await flush();
    expect(sb.rows).toHaveLength(0); // degraded → no further writes attempted
  });
});

describe("durable mod audit — (d) the less-destructive actions named in the migration are audited too", () => {
  // The migration's `action` column comment lists unmute | remove_warning |
  // clear_warnings as expected values. These previously wrote only the in-memory
  // ring (logAudit) and skipped the durable table; assert they now append a row.
  it("unmute_user writes action=unmute with actor/target/reason/source", async () => {
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ManageRoles, "mod-actor");
    const target = buildTarget("victim-unmute");
    // Member currently carries the mute role; guild exposes a configured role.
    target.roles = { cache: { has: (rid: string) => rid === "mute-role" }, remove: vi.fn(async () => {}) } as any;
    (guild as any).roles = { cache: { get: (rid: string) => (rid === "mute-role" ? { id: "mute-role", name: "Muted" } : null) } };
    vi.mocked(getGuildSettings).mockReturnValueOnce({ mute_role_id: "mute-role" } as any);

    const result = await executeMod("unmute_user", { username: "victim", reason: "appeal accepted" }, buildMessage(member, guild), buildCtx(guild, target));
    expect(String(result)).toMatch(/unmuted/i);

    await flush();
    expect(sb.rows).toHaveLength(1);
    const row = sb.rows[0];
    expect(row.action).toBe("unmute");
    expect(row.actor_id).toBe("mod-actor");
    expect(row.target_id).toBe("victim-unmute");
    expect(row.reason).toBe("appeal accepted");
    expect(row.source).toBe("slash");
    expect(row.instruction).toBeNull();
  });

  it("remove_warning writes action=remove_warning with target=warning id", async () => {
    vi.mocked(deleteWarning).mockReturnValueOnce({ changes: 1 } as any);
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ModerateMembers, "mod-actor");
    const target = buildTarget();

    const result = await executeMod("remove_warning", { warning_id: 42, reason: "mistaken" }, buildMessage(member, guild), buildCtx(guild, target));
    expect(String(result)).toMatch(/removed warning #42/i);

    await flush();
    expect(sb.rows).toHaveLength(1);
    const row = sb.rows[0];
    expect(row.action).toBe("remove_warning");
    expect(row.actor_id).toBe("mod-actor");
    expect(row.target_id).toBe("42");
    expect(row.reason).toBe("mistaken");
  });

  it("clear_warnings writes action=clear_warnings, and captures the AI instruction on the AI path", async () => {
    vi.mocked(getWarnings).mockReturnValueOnce([{ id: 1 }] as any); // one warning to clear
    vi.mocked(clearWarnings).mockReturnValueOnce({ changes: 1 } as any);
    const guild = buildGuild();
    const member = buildPermedMember(PermissionFlagsBits.ModerateMembers, "mod-actor");
    const target = buildTarget("victim-clear");
    const msg = buildMessage(member, guild, "wipe their warnings");
    const ctx = buildCtx(guild, target, { aiInitiated: true });

    const result = await executeMod("clear_warnings", { username: "victim", reason: "amnesty" }, msg, ctx);
    expect(String(result)).toMatch(/cleared 1 warning/i);

    await flush();
    expect(sb.rows).toHaveLength(1);
    const row = sb.rows[0];
    expect(row.action).toBe("clear_warnings");
    expect(row.actor_id).toBe("mod-actor");
    expect(row.target_id).toBe("victim-clear");
    expect(row.reason).toBe("amnesty");
    expect(row.source).toBe("ai-tool");
    expect(row.instruction).toBe("wipe their warnings");
  });
});

describe("durable mod audit — degrades safely when Supabase is unconfigured", () => {
  it("getSupabase() returning null is a no-op (no throw, action succeeds)", async () => {
    const prev = sb.state.client;
    sb.state.client = null;
    try {
      const guild = buildGuild();
      const member = buildPermedMember(PermissionFlagsBits.BanMembers, "mod-actor");
      const target = buildTarget();
      const result = await executeMod("ban_user", { username: "victim", reason: "x" }, buildMessage(member, guild), buildCtx(guild, target));
      expect(String(result)).toMatch(/banned/i);
      expect(target.ban).toHaveBeenCalledTimes(1);
      await flush();
      expect(sb.rows).toHaveLength(0);
    } finally {
      sb.state.client = prev;
    }
  });
});
