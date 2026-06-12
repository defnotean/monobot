// Regression tests for the executor's alias validator + unknown-tool tracking.
//
// These mirror the guardrails Eris's executor (packages/eris/ai/executor.js)
// has had: a boot-time `validateToolAliases` that catches a TOOL_ALIASES value
// pointing at a tool that no longer exists (silent alias drift), and an
// `_unknownToolCounts` tracker so a hallucinated tool name surfaces in the log
// instead of vanishing into the "Unknown action" fallback.
//
// The pieces under test:
//   - validateToolAliases(registry, { throwOnDrift }) — throws (or, in soft
//     mode, returns the offenders) when an alias target isn't in the registry.
//   - The live TOOL_ALIASES are clean against the real tool registry.
//   - executeTool tracks an unknown tool name in _unknownToolCounts.

import { describe, it, expect } from "vitest";

// @ts-expect-error - importing JS module without types
import {
  TOOL_ALIASES,
  validateToolAliases,
  executeTool,
  _unknownToolCounts,
} from "../../ai/executor.js";
// @ts-expect-error - importing JS module without types
import { ADMIN_TOOLS, EVERYONE_TOOLS } from "../../ai/tools.js";
// @ts-expect-error - importing JS module without types
import { channelKeyFor, registry } from "../../ai/toolRegistry.js";

const realToolNames = new Set(
  [...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t: { name: string }) => t.name)
);

describe("executor alias validation", () => {
  it("passes for the live alias map against the real tool registry", () => {
    // No drift in production aliases — returns an empty offender list and does
    // not throw. (The module-load boot audit would have already thrown if this
    // weren't true, so import succeeding is itself a check.)
    expect(validateToolAliases(realToolNames, { throwOnDrift: false })).toEqual([]);
    expect(() => validateToolAliases(realToolNames, { throwOnDrift: true })).not.toThrow();
  });

  it("keeps old converged tool names as aliases to verb_noun canonical names", () => {
    expect(TOOL_ALIASES.reminder_set).toBe("set_reminder");
    expect(TOOL_ALIASES.reminder_cancel).toBe("cancel_reminder");
    expect(TOOL_ALIASES.forget_memory).toBe("forget_fact");
    expect(TOOL_ALIASES.clear_all_memories).toBe("forget_all");
    expect(TOOL_ALIASES.web_read).toBe("scrape_url");
    expect(TOOL_ALIASES.list_trusted_users).toBe("list_trusted");
  });

  it("does not keep dead self-aliases for already-canonical tools", () => {
    expect(TOOL_ALIASES).not.toHaveProperty("snipe");
    expect(TOOL_ALIASES).not.toHaveProperty("editsnipe");
    expect(TOOL_ALIASES).not.toHaveProperty("set_birthday");
  });

  it("flags an alias whose target tool doesn't exist (drift)", () => {
    // Build a registry missing one alias target. validateToolAliases should
    // detect the dangling alias and throw a clear, actionable error.
    const firstAlias = Object.keys(TOOL_ALIASES)[0];
    const missingTarget = TOOL_ALIASES[firstAlias];
    const registryWithoutTarget = new Set(
      [...realToolNames].filter((n) => n !== missingTarget)
    );

    expect(() =>
      validateToolAliases(registryWithoutTarget, { throwOnDrift: true })
    ).toThrow(/TOOL_ALIASES drift detected/);

    // Soft mode reports the offenders instead of crashing.
    const offenders = validateToolAliases(registryWithoutTarget, { throwOnDrift: false });
    expect(offenders).toContain(missingTarget);
  });

  it("tracks an unknown (hallucinated) tool name when dispatched", async () => {
    const fakeName = `__hallucinated_tool_${Math.random().toString(36).slice(2)}`;
    const message: any = {
      author: { id: "111111111111111111", username: "tester" },
      guild: null,
      content: "",
    };

    expect(_unknownToolCounts.has(fakeName)).toBe(false);

    const result = await executeTool(fakeName, {}, message);
    expect(result).toBe(`Unknown action: ${fakeName}`);
    expect(_unknownToolCounts.get(fakeName)).toBe(1);

    // A second dispatch increments the same counter (so first-hit + every-10th
    // log throttling has a real count to gate on).
    await executeTool(fakeName, { foo: "bar" }, message);
    expect(_unknownToolCounts.get(fakeName)).toBe(2);
  });

  it("tracks successful dispatches under the same channel key used by selection", async () => {
    const message: any = {
      author: { id: "111111111111111114", username: "tester" },
      guild: { id: "guild-usage-irene" },
      channel: { id: "channel-usage-irene" },
      content: "",
    };
    const key = channelKeyFor(message);
    registry._recentUsage.delete(key);

    const result = await executeTool("calculate", { expression: "2 + 3" }, message);

    expect(String(result)).toContain("5");
    expect(registry._recentUsage.get(key)?.[0]).toBe("calculate");
    expect(key).toBe("guild-usage-irene-111111111111111114");
  });

  it("does not track unknown dispatches as recent successful usage", async () => {
    const fakeName = `__hallucinated_recent_${Math.random().toString(36).slice(2)}`;
    const message: any = {
      author: { id: "111111111111111115", username: "tester" },
      guild: null,
      content: "",
    };
    const key = channelKeyFor(message);
    registry._recentUsage.delete(key);

    await executeTool(fakeName, {}, message);

    expect(registry._recentUsage.has(key)).toBe(false);
  });
});
