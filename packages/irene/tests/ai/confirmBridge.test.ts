// Regression tests for the AI destructive-action CONFIRM render bridge.
//
// The pieces under test:
//   - isDeferralResult / postDeferralIfNeeded (executor.js): detect a
//     pending-confirm OBJECT and POST it as a real Discord message, feeding the
//     model a short pending-notice string instead of the raw object.
//   - executeTool threading ctx.aiInitiated through to moderationExecutor so the
//     confirm gate engages for AI-originated calls (and NOT for slash-equivalent
//     calls that omit the flag).
//   - End-to-end-ish: AI ban → pending (NOT executed) → committed handler path
//     → executed.
//
// Fail-closed property: if the bridge can't post the confirm prompt, it must
// surface an error string (never auto-execute, never silently drop).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collection, PermissionFlagsBits } from "discord.js";

// executor.js → moderationExecutor.js touches sendModLog/twinPunish on the
// confirmed-commit path; stub them so the commit step doesn't reach Discord/DB.
vi.mock("../../utils/logger.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, sendModLog: vi.fn(async () => {}) };
});
vi.mock("../../utils/twinPunish.js", () => ({
  firePunishSignal: vi.fn(async () => undefined),
}));

// @ts-expect-error - importing JS module without types
import {
  executeTool,
  isDeferralResult,
  postDeferralIfNeeded,
  PENDING_CONFIRM_NOTICE,
} from "../../ai/executor.js";
// @ts-expect-error - importing JS module without types
import {
  consumePendingAction,
  getPendingAction,
  commitPendingAction,
} from "../../ai/executors/moderationExecutor.js";
// @ts-expect-error - importing JS module without types
import { logAudit } from "../../database.js";
import { _resetForTest as _resetToolRateLimit } from "@defnotean/shared/toolRateLimit";

vi.mock("../../database.js", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    logAudit: vi.fn(),
    getWarnings: vi.fn(() => []),
    addTempBan: vi.fn(),
  };
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function buildModMember(id = "200000000000000002") {
  return {
    id,
    // Mod has BanMembers but is NOT the owner — exercises the real perm check.
    permissions: { has: (p: bigint) => p === PermissionFlagsBits.BanMembers },
    roles: { highest: { position: 10 } },
  };
}

function buildTarget(id = "300000000000000003") {
  return {
    id,
    user: { id, tag: "victim#0001", username: "victim", createdTimestamp: 0 },
    bannable: true,
    nickname: null,
    joinedTimestamp: 0,
    roles: { highest: { position: 1 }, cache: { has: () => false } },
    ban: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
  };
}

// A guild whose members.cache the executor's findMember indexes by username.
function buildGuild(guildId: string, target: any) {
  const members = new Collection<string, any>();
  members.set(target.id, target);
  return {
    id: guildId,
    ownerId: "100000000000000001",
    name: "Test Guild",
    client: { user: { id: "500000000000000005" } },
    members: { cache: members },
    roles: { everyone: { id: guildId }, cache: new Collection() },
  };
}

function buildMessage(guildId: string, target: any, send = vi.fn(async () => ({}))) {
  const guild = buildGuild(guildId, target);
  const member = buildModMember();
  return {
    author: { id: member.id, tag: "mod#0001", username: "mod" },
    member,
    client: guild.client,
    channel: { id: "channel-1", name: "general", send },
    guild,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The destructive-tool rate caps (ban_user 5/5min etc.) persist module-scope
  // window state across executeTool calls within this file. Reset so the file
  // is immune to the cap regardless of how many ban_user calls it accumulates.
  _resetToolRateLimit();
});

// ─── (a) detection + post ──────────────────────────────────────────────────

describe("isDeferralResult", () => {
  it("recognizes a pending-confirm object", () => {
    expect(isDeferralResult({ content: "x", components: [{}], _pendingToken: "abc123" })).toBe(true);
  });

  it("rejects normal string results and plain objects", () => {
    expect(isDeferralResult("Banned someone")).toBe(false);
    expect(isDeferralResult(undefined)).toBe(false);
    expect(isDeferralResult(null)).toBe(false);
    expect(isDeferralResult({ error: "nope" })).toBe(false); // twin {error} shape
    expect(isDeferralResult({ _pendingToken: "x" })).toBe(false); // no components
    expect(isDeferralResult({ components: [] })).toBe(false); // no token
  });
});

describe("postDeferralIfNeeded (the render bridge)", () => {
  it("(a) a deferral object → channel.send with components, returns the pending notice", async () => {
    const send = vi.fn(async () => ({}));
    const deferral = { content: "⚠️ Ban victim — confirm?", components: [{ kind: "row" }], _pendingToken: "tok123" };

    const fed = await postDeferralIfNeeded(deferral, { send });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.content).toBe(deferral.content);
    expect(payload.components).toBe(deferral.components);
    // The MODEL sees the short pending string, not the raw object.
    expect(fed).toBe(PENDING_CONFIRM_NOTICE);
  });

  it("(b) a normal string result passes through untouched, no send", async () => {
    const send = vi.fn(async () => ({}));
    const fed = await postDeferralIfNeeded("Timed out victim for 1h", { send });
    expect(send).not.toHaveBeenCalled();
    expect(fed).toBe("Timed out victim for 1h");
  });

  it("fail-closed: when channel.send throws, returns an error string (never the success/object)", async () => {
    const send = vi.fn(async () => { throw new Error("Missing Permissions"); });
    const deferral = { content: "x", components: [{}], _pendingToken: "tok456" };
    const fed = await postDeferralIfNeeded(deferral, { send });
    expect(typeof fed).toBe("string");
    expect(fed).toMatch(/NOT performed/i);
    expect(fed).not.toBe(PENDING_CONFIRM_NOTICE);
  });

  it("fail-closed: with no usable channel, reports it was NOT performed", async () => {
    const deferral = { content: "x", components: [{}], _pendingToken: "tok789" };
    const fed = await postDeferralIfNeeded(deferral, null);
    expect(fed).toMatch(/NOT performed/i);
  });
});

// ─── (c) end-to-end-ish: AI ban defers, then commit executes ─────────────────

describe("end-to-end AI ban: defer → commit", () => {
  it("AI-initiated ban does NOT execute inline; it returns a deferral the bridge can post", async () => {
    const target = buildTarget();
    const send = vi.fn(async () => ({}));
    const msg = buildMessage("g-ban-1", target, send);

    const result = await executeTool("ban_user", { username: "victim", reason: "spam" }, msg, { aiInitiated: true });

    // No inline ban — a deferral object came back instead.
    expect(target.ban).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(isDeferralResult(result)).toBe(true);

    // The bridge posts the Confirm/Cancel buttons as a real message and feeds
    // the model the pending notice.
    const fed = await postDeferralIfNeeded(result, msg.channel);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].components).toBe((result as any).components);
    expect(fed).toBe(PENDING_CONFIRM_NOTICE);
    // Still no ban — the action is pending.
    expect(target.ban).not.toHaveBeenCalled();

    // Simulate the committed handler (events/interactionCreate.js modconfirm path):
    // consume the token then commit with the clicking mod's perms.
    const taken = consumePendingAction((result as any)._pendingToken);
    expect(taken).not.toBeNull();
    const outcome = await commitPendingAction(taken, {
      guild: msg.guild,
      member: buildModMember("clicker-mod"),
      clickedBy: { id: "clicker-mod", tag: "clicker#0001" },
      deps: {
        findMember: () => target,
        checkHierarchy: () => null,
        logAudit,
        addTempBan: vi.fn(),
        firePunishSignal: () => Promise.resolve(),
      },
    });

    // NOW the ban actually fires.
    expect(outcome.ok).toBe(true);
    expect(target.ban).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(msg.guild.id, "ban", "clicker-mod", "victim");
    // Token is one-shot — already consumed.
    expect(getPendingAction((result as any)._pendingToken)).toBeNull();
  });

  it("fail-closed cleanup: when the post throws, the orphaned pending token is reclaimed (not left to TTL)", async () => {
    const target = buildTarget();
    const send = vi.fn(async () => { throw new Error("Missing Permissions"); });
    const msg = buildMessage("g-ban-3", target, send);

    const result = await executeTool("ban_user", { username: "victim", reason: "spam" }, msg, { aiInitiated: true });
    expect(isDeferralResult(result)).toBe(true);
    const token = (result as any)._pendingToken;
    // Real entry is stashed before the bridge runs.
    expect(getPendingAction(token)).not.toBeNull();

    const fed = await postDeferralIfNeeded(result, msg.channel);
    expect(fed).toMatch(/NOT performed/i);
    expect(target.ban).not.toHaveBeenCalled();
    // The unreachable entry was reclaimed immediately, not left to TTL-expire.
    expect(getPendingAction(token)).toBeNull();
  });

  it("fail-closed cleanup: with no usable channel, the orphaned pending token is reclaimed", async () => {
    const target = buildTarget();
    const msg = buildMessage("g-ban-4", target);

    const result = await executeTool("ban_user", { username: "victim", reason: "spam" }, msg, { aiInitiated: true });
    expect(isDeferralResult(result)).toBe(true);
    const token = (result as any)._pendingToken;
    expect(getPendingAction(token)).not.toBeNull();

    const fed = await postDeferralIfNeeded(result, null);
    expect(fed).toMatch(/NOT performed/i);
    expect(target.ban).not.toHaveBeenCalled();
    expect(getPendingAction(token)).toBeNull();
  });

  it("a NON-AI ban (no aiInitiated) bans immediately — slash-equivalent path unchanged", async () => {
    const target = buildTarget();
    const msg = buildMessage("g-ban-2", target);

    const result = await executeTool("ban_user", { username: "victim", reason: "spam" }, msg /* no opts */);

    expect(isDeferralResult(result)).toBe(false);
    expect(target.ban).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/banned/i);
  });
});
