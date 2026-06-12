import { describe, expect, it } from "vitest";
// @ts-expect-error JS module without types
import { _unknownToolCounts, clearUnknownToolCounts, TOOL_ALIASES, executeTool, resolveToolName, validateToolAliases } from "../../ai/executor.js";
// @ts-expect-error JS module without types
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";
// @ts-expect-error JS module without types
import { channelKeyFor, registry } from "../../ai/toolRegistry.js";

// Covers the three pieces of the alias-vs-registry contract added so the model
// gets a structured signal when its emitted tool name is not real (rather than
// silently sliding through the default-case "unknown tool" string in the
// sub-executor fallback path).
//
//   (a) a real alias resolves to its canonical registered tool
//   (b) an unknown post-alias name produces a structured error
//   (c) the validator surfaces drift between TOOL_ALIASES values and the registry

describe("executor alias resolution + registry validation", () => {
  it("(a) resolves a known alias to its canonical registered tool name", () => {
    const registered = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t: any) => t.name));

    // `balance` is one of the more-traveled aliases in TOOL_ALIASES.
    // Asserting on the literal map first locks down the alias itself, then we
    // verify resolveToolName mirrors that mapping AND the target is in the registry.
    expect(TOOL_ALIASES.balance).toBe("check_balance");

    const resolved = resolveToolName("balance");
    expect(resolved.known).toBe(true);
    expect(resolved.aliasUsed).toBe(true);
    expect(resolved.originalName).toBe("balance");
    expect(resolved.name).toBe("check_balance");
    expect(registered.has(resolved.name)).toBe(true);
  });

  it("(b) returns a structured {unknown, normalized} error for a name that is not in the registry post-alias", () => {
    // A name with no alias mapping and not in the registry: normalized == original.
    const out = resolveToolName("definitely_not_a_real_tool_xyz");
    expect(out.known).toBe(false);
    expect(out.aliasUsed).toBe(false);
    expect(out.error).toEqual({
      unknown: "definitely_not_a_real_tool_xyz",
      normalized: "definitely_not_a_real_tool_xyz",
    });

    // And a name whose alias target itself does not exist — exercise the second
    // failure mode via a custom registry that omits the canonical target. This
    // simulates the post-rename drift scenario (alias still on the books but
    // the tool was deleted), without mutating the real registry.
    const shrunkRegistry = new Set<string>(); // empty
    const out2 = resolveToolName("balance", shrunkRegistry);
    expect(out2.known).toBe(false);
    expect(out2.aliasUsed).toBe(true);
    expect(out2.error).toEqual({ unknown: "balance", normalized: "check_balance" });
  });

  it("(c) boot-time validator catches drift when an alias points outside the registry", () => {
    // Mocked registry that is missing one canonical target every TOOL_ALIASES
    // entry maps to. Forces every alias-target → "drift". throwOnDrift: false
    // gives us the offender list back without aborting the test runner or
    // dumping hundreds of aliases into test output; we separately verify the
    // throwing path raises a clear, capped error too.
    const emptyRegistry = new Set<string>();
    const offenders = validateToolAliases(emptyRegistry, { throwOnDrift: false });
    expect(offenders.length).toBeGreaterThan(0);
    // Every reported offender must actually be one of the alias targets.
    const aliasTargets = new Set<string>(Object.values(TOOL_ALIASES) as string[]);
    for (const t of offenders) expect(aliasTargets.has(t)).toBe(true);

    expect(() => validateToolAliases(emptyRegistry, { throwOnDrift: true, maxExamples: 3 }))
      .toThrowError(/TOOL_ALIASES drift detected: \d+ alias\(es\)[\s\S]*Showing first 3[\s\S]*more alias\(es\) omitted/);

    const messages: string[] = [];
    validateToolAliases(emptyRegistry, {
      throwOnDrift: false,
      logOnDrift: true,
      maxExamples: 2,
      logger: (message: string) => messages.push(message),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].split("\n").length).toBeLessThanOrEqual(4);
    expect(messages[0]).toMatch(/Showing first 2[\s\S]*more alias\(es\) omitted/);

    // And the happy path: the *real* registry must have zero drift today — if
    // a future PR breaks this, the module-load assertion in executor.js will
    // crash at boot, but this test also fails first which is a friendlier signal.
    const realRegistry = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t: any) => t.name));
    expect(validateToolAliases(realRegistry, { throwOnDrift: false })).toEqual([]);
  });

  it("blocks owner-only tools at the central executor boundary for non-owners", async () => {
    const result = await executeTool("execute_terminal", { command: "echo no" }, {
      author: { id: "111111111111111111" },
      guild: { id: "guild-1" },
      channel: { id: "channel-1" },
    } as any);

    expect(String(result)).toMatch(/owner-only/i);
  });

  it("tracks successful dispatches under the same channel key used by selection", async () => {
    const message: any = {
      author: { id: "111111111111111112" },
      guild: { id: "guild-usage-eris" },
      channel: { id: "channel-usage-eris" },
      content: "",
    };
    const key = channelKeyFor(message);
    registry._recentUsage.delete(key);

    const result = await executeTool("list_features", {}, message);

    expect(String(result)).toContain("server feature config");
    expect(registry._recentUsage.get(key)?.[0]).toBe("list_features");
    expect(key).toBe("ch:channel-usage-eris");
  });

  it("does not track unknown or economy-mutating tool dispatches", async () => {
    const message: any = {
      author: { id: "111111111111111113" },
      guild: { id: "guild-usage-skip" },
      channel: { id: "channel-usage-skip", send: async () => ({}) },
      content: "",
    };
    const key = channelKeyFor(message);
    const fakeTool = "__definitely_not_real_usage_tool";
    registry._recentUsage.delete(key);
    clearUnknownToolCounts();

    await executeTool(fakeTool, {}, message);
    expect(registry._recentUsage.has(key)).toBe(false);
    expect(_unknownToolCounts.get(fakeTool)).toBe(1);

    await executeTool("shop_browse", {}, message);
    expect(registry._recentUsage.has(key)).toBe(false);
  });
});
