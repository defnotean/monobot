import { describe, it, expect, beforeEach, vi } from "vitest";

// autoModerationRuleDelete mirrors the create handler but reads the
// AUTO_MODERATION_RULE_DELETE audit (type 142). We exercise actor attribution,
// the stale/mismatch guards, unknown trigger fallback, and the throwing path.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/autoModerationRuleDelete.js";

function makeRule({ entry = undefined, fetchThrows = false, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  return {
    id: "rule-9",
    name: "Old Rule",
    triggerType: 3,
    enabled: false,
    guild: { fetchAuditLogs },
    _fetchAuditLogs: fetchAuditLogs,
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("autoModerationRuleDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("autoModerationRuleDelete");
  });

  it("queries the delete audit log (type 142) and renders rule meta", async () => {
    const rule = makeRule();
    await execute(rule);
    expect(rule._fetchAuditLogs).toHaveBeenCalledWith({ type: 142, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Auto-Mod Rule Deleted");
    expect(payload.meta["Trigger"]).toBe("Spam Detection");
    expect(payload.meta["Was Enabled"]).toBe("no");
    expect(sendModLog).toHaveBeenCalledWith(rule.guild, payload);
  });

  it("attributes a fresh matching audit entry", async () => {
    const rule = makeRule({
      entry: { target: { id: "rule-9" }, executor: { id: "mod-3" }, reason: "cleanup", createdTimestamp: Date.now() },
    });
    await execute(rule);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.actor).toEqual({ id: "mod-3" });
    expect(payload.description).toContain("by <@mod-3>");
  });

  it("does not attribute a stale entry", async () => {
    const rule = makeRule({
      entry: { target: { id: "rule-9" }, executor: { id: "mod-3" }, createdTimestamp: Date.now() - 9000 },
    });
    await execute(rule);
    expect(logEvent.mock.calls[0][0].actor).toBeNull();
  });

  it("survives a throwing audit fetch and falls back to unknown trigger label", async () => {
    const rule = makeRule({ fetchThrows: true, triggerType: 77 });
    await expect(execute(rule)).resolves.not.toThrow();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0].meta["Trigger"]).toBe("type 77");
  });
});
