import { describe, it, expect, beforeEach, vi } from "vitest";

// autoModerationRuleUpdate diffs old vs new rule and only logs when something
// actually changed. We exercise: the early-return when nothing changed, each
// diffed property (name/enabled/keywords/actions) appearing in the before/after
// fields + changedKeys description, the Enabled vs Disabled key wording, and
// actor attribution via the type-141 audit log.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/autoModerationRuleUpdate.js";

function ruleBase(overrides: any = {}) {
  return {
    id: "rule-5",
    name: "Filter",
    enabled: true,
    triggerMetadata: { keywordFilter: ["a"] },
    actions: [{ type: 1 }],
    ...overrides,
  };
}

function guildWith({ entry = undefined, fetchThrows = false }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  return { fetchAuditLogs, _fetchAuditLogs: fetchAuditLogs };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("autoModerationRuleUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("autoModerationRuleUpdate");
  });

  it("returns early WITHOUT logging when nothing changed", async () => {
    const guild = guildWith();
    const old = ruleBase();
    const next = ruleBase({ guild });
    await execute(old, next);
    expect(sendModLog).not.toHaveBeenCalled();
    expect(guild._fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("logs a name change with before/after field text", async () => {
    const guild = guildWith();
    const old = ruleBase({ name: "Old Name" });
    const next = ruleBase({ name: "New Name", guild });
    await execute(old, next);
    expect(sendModLog).toHaveBeenCalledTimes(1);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.description).toContain("`Name`");
    expect(payload.fields[0].value).toContain("Old Name");
    expect(payload.fields[1].value).toContain("New Name");
  });

  it("uses the 'Disabled' key when enabled flips true->false (and 'Enabled' for the reverse)", async () => {
    const guild = guildWith();
    await execute(ruleBase({ enabled: true }), ruleBase({ enabled: false, guild }));
    expect(logEvent.mock.calls[0][0].description).toContain("`Disabled`");

    logEvent.mockClear();
    sendModLog.mockClear();
    const guild2 = guildWith();
    await execute(ruleBase({ enabled: false }), ruleBase({ enabled: true, guild: guild2 }));
    expect(logEvent.mock.calls[0][0].description).toContain("`Enabled`");
  });

  it("detects keyword-count and action-count changes", async () => {
    const guild = guildWith();
    const old = ruleBase({ triggerMetadata: { keywordFilter: ["a"] }, actions: [{ type: 1 }] });
    const next = ruleBase({
      triggerMetadata: { keywordFilter: ["a", "b", "c"] },
      actions: [{ type: 1 }, { type: 2 }],
      guild,
    });
    await execute(old, next);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.description).toContain("`Keywords`");
    expect(payload.description).toContain("`Actions`");
    expect(payload.fields[0].value).toContain("1 filtered");
    expect(payload.fields[1].value).toContain("3 filtered");
  });

  it("attributes the actor from a fresh type-141 audit entry", async () => {
    const guild = guildWith({
      entry: { target: { id: "rule-5" }, executor: { id: "mod-2" }, reason: "tweak", createdTimestamp: Date.now() },
    });
    await execute(ruleBase({ name: "A" }), ruleBase({ name: "B", guild }));
    expect(guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 141, limit: 1 });
    expect(logEvent.mock.calls[0][0].actor).toEqual({ id: "mod-2" });
  });

  it("handles a null oldRule (uses '?' placeholder) without throwing", async () => {
    const guild = guildWith();
    await execute(null, ruleBase({ name: "Brand New", guild }));
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0].fields[0].value).toContain("?");
  });
});
