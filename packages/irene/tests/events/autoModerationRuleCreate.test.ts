import { describe, it, expect, beforeEach, vi } from "vitest";

// autoModerationRuleCreate fetches the AUTO_MODERATION_RULE_CREATE audit entry
// (type 140) to attribute an actor, summarizes the rule's actions, and logs.
// We exercise: actor attribution when a fresh matching audit entry exists, no
// attribution when the entry is stale / mismatched, the action-summary mapping,
// and graceful handling when fetchAuditLogs throws.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/autoModerationRuleCreate.js";

function makeAudit(entry: any) {
  return { entries: { first: () => entry ?? null } };
}

function makeRule({ entry = undefined, fetchThrows = false, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async (opts: any) => {
    if (fetchThrows) throw new Error("Missing Audit Log permission");
    return makeAudit(entry);
  });
  return {
    id: "rule-1",
    name: "Keyword Block",
    triggerType: 1,
    enabled: true,
    actions: [{ type: 1 }, { type: 3 }],
    triggerMetadata: { keywordFilter: ["a", "b"], presets: [] },
    guild: { fetchAuditLogs },
    _fetchAuditLogs: fetchAuditLogs,
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("autoModerationRuleCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("autoModerationRuleCreate");
  });

  it("queries the create audit log (type 140) and summarizes actions", async () => {
    const rule = makeRule();
    await execute(rule);
    expect(rule._fetchAuditLogs).toHaveBeenCalledWith({ type: 140, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Auto-Mod Rule Created");
    expect(payload.meta["Actions"]).toBe("Block, Timeout");
    expect(payload.meta["Trigger"]).toBe("Keyword Filter");
    expect(payload.meta["Enabled"]).toContain("yes");
    expect(payload.meta["Keyword Count"]).toBe(2);
  });

  it("attributes the actor when a fresh matching audit entry exists", async () => {
    const rule = makeRule({
      entry: {
        target: { id: "rule-1" },
        executor: { id: "mod-7" },
        reason: "tightening filters",
        createdTimestamp: Date.now() - 500,
      },
    });
    await execute(rule);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.actor).toEqual({ id: "mod-7" });
    expect(payload.reason).toBe("tightening filters");
    expect(payload.description).toContain("by <@mod-7>");
  });

  it("ignores a stale audit entry (older than 5s) — no actor", async () => {
    const rule = makeRule({
      entry: {
        target: { id: "rule-1" },
        executor: { id: "mod-7" },
        reason: "old",
        createdTimestamp: Date.now() - 10_000,
      },
    });
    await execute(rule);
    expect(logEvent.mock.calls[0][0].actor).toBeNull();
  });

  it("ignores an audit entry whose target is a different rule", async () => {
    const rule = makeRule({
      entry: {
        target: { id: "some-other-rule" },
        executor: { id: "mod-7" },
        createdTimestamp: Date.now(),
      },
    });
    await execute(rule);
    expect(logEvent.mock.calls[0][0].actor).toBeNull();
  });

  it("still logs when the audit fetch throws and renders fallbacks for empty actions/unknown trigger", async () => {
    const rule = makeRule({ fetchThrows: true, actions: [], triggerType: 999, triggerMetadata: {} });
    await expect(execute(rule)).resolves.not.toThrow();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.actor).toBeNull();
    expect(payload.meta["Actions"]).toBe("*(none)*");
    expect(payload.meta["Trigger"]).toBe("type 999");
    expect(payload.meta["Keyword Count"]).toBeNull();
  });
});
