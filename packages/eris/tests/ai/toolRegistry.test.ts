import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../../utils/logger.js";
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";
import { MAX_TIER1_TOOLS, registry } from "../../ai/toolRegistry.js";

// Capture registry log lines (shadow-cap telemetry assertions below) while
// keeping the rest of the logger surface intact.
vi.mock("../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/logger.js")>();
  return { ...actual, log: vi.fn() };
});

// Keyword-rich message that matches many categories at once — the shape of
// message that used to blow Tier 1 up to 75 schemas before the cap.
const KITCHEN_SINK_MESSAGE =
  "check my balance and the shop, bet coins on slots and blackjack, rob someone, " +
  "buy stock and start a heist, feed my pet, go fish and hunt and dig and work, " +
  "review this code snippet, watch the bitcoin price news, tell my fortune and " +
  "curse him, set a reminder, remember this fact, search the web, and only fire " +
  "events in this channel";

// Parse the tool names out of a Tier-2 catalog block. Lines are
// "- category: tool_one, tool_two".
function catalogNames(catalog: string): Set<string> {
  const names = new Set<string>();
  for (const line of catalog.split("\n")) {
    const m = line.match(/^- [^:]+:\s*(.*)$/i);
    if (!m) continue;
    for (const name of m[1].split(/,\s*/)) {
      if (/^[a-z0-9_]+$/i.test(name)) names.add(name);
    }
  }
  return names;
}

function reachableNames(tier1: Array<{ name: string }>, tier2Catalog: string): Set<string> {
  return new Set([
    ...tier1.map((t) => t.name),
    ...catalogNames(tier2Catalog),
  ]);
}

describe("tool registry", () => {
  it("registers every declared Eris AI tool", () => {
    const declared = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((tool) => tool.name));
    const registered = new Set(registry.getAllToolNames());

    expect(registered).toEqual(declared);
  });

  it("keeps always-included core tools selectable", () => {
    const { tier1 } = registry.selectByMessage("", {
      isOwner: true,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier1Names = new Set(tier1.map((tool) => tool.name));

    expect(tier1Names).toContain("remember_fact");
    expect(tier1Names).toContain("web_search");
    expect(tier1Names).toContain("ask_irene");
  });
});

describe("two-tier selection (Eris)", () => {
  // (a) COMPLETENESS — every accessible tool must appear in Tier 1 (schema)
  // OR the Tier-2 catalog (by name). Nothing may be unreachable.
  it("Tier-1 ∪ Tier-2-catalog covers the full accessible tool set (owner)", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey what's up", {
      isOwner: true,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const reachable = reachableNames(tier1, tier2Catalog);
    const accessible = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name));
    expect(reachable).toEqual(accessible);
  });

  it("Tier-1 ∪ Tier-2-catalog covers the full accessible tool set (non-owner)", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey what's up", {
      isOwner: false,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const reachable = reachableNames(tier1, tier2Catalog);
    // Non-owner should NOT see owner-only tools, but must reach every
    // everyone-tool somewhere.
    const everyoneNames = new Set(EVERYONE_TOOLS.map((t) => t.name));
    for (const name of everyoneNames) expect(reachable).toContain(name);
    const ownerOnly = OWNER_TOOLS.map((t) => t.name).filter((n) => !everyoneNames.has(n));
    for (const name of ownerOnly) expect(reachable).not.toContain(name);
  });

  // (b) A message with a category keyword pulls that category into Tier 1.
  // Under the Tier-1 cap the whole games category no longer fits: the tool
  // whose own name tokens match the message wins a slot, and the rest of the
  // category stays reachable by exact name through Tier 2.
  it("routes a gambling-keyword message to the games category in Tier 1", () => {
    const { tier1, tier2Names } = registry.selectByMessage("eris slots spin pls", {
      isOwner: false,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    expect(tier1Names).toContain("slots_spin");
    expect([...tier1Names, ...tier2Names]).toContain("blackjack_start");
  });

  it("keeps the name-matched game tool in Tier 1 for a blackjack message", () => {
    const { tier1 } = registry.selectByMessage("deal me in, play blackjack", {
      isOwner: false,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    expect(tier1Names).toContain("blackjack_start");
  });

  // Regression: a strong name-token intent match must outrank the recent-usage
  // band (891–900), or the cap's 3 non-core slots on Eris all get eaten by
  // stale recent usage and the tool the user explicitly named falls to Tier 2.
  it("a name-token intent match beats stale recent-usage for a Tier-1 slot", () => {
    const channelKey = `recent-vs-keyword-${Date.now()}`;
    // Seed the channel with non-game recent usage (these score 891–900). With
    // 29 cores + a 32 cap there are only 3 non-core slots to fight over.
    for (const name of ["check_balance", "stock_market", "coin_leaderboard", "check_prices", "check_presence"]) {
      registry.trackUsage(channelKey, name);
    }
    const { tier1, tier2Names } = registry.selectByMessage("play blackjack", {
      isOwner: false,
      channelKey,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    // The explicitly-named tool wins a slot despite the channel's recent usage.
    expect(tier1Names).toContain("blackjack_start");
    // And it is NOT relegated to the Tier-2 name catalog.
    expect(tier2Names).not.toContain("blackjack_start");
  });

  // (c) Tier-1 is materially smaller than the full set — the token win.
  it("Tier-1 schema count is far smaller than the full tool set", () => {
    const full = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name)).size;
    const { tier1 } = registry.selectByMessage("hey", {
      isOwner: true,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    expect(tier1.length).toBeLessThan(full * 0.6);
  });

  it("uses a compact grouped Tier-2 catalog instead of per-tool descriptions", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey", {
      isOwner: true,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier2Names = catalogNames(tier2Catalog);
    const byName = new Map([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((tool) => [tool.name, tool]));
    const full = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name)).size;
    const legacyVerboseCatalog =
      "\n\nOTHER AVAILABLE TOOLS (call these through use_tool with {tool_name, arguments}; do not write tool syntax as text):\n" +
      [...tier2Names]
        .map((name) => `- ${name}: ${(byName.get(name)?.description || "").split(/\.\s/)[0]}`)
        .join("\n");

    expect(tier1.length).toBeLessThan(full * 0.6);
    expect(tier2Names.size).toBeGreaterThan(50);
    expect(tier2Catalog.length).toBeLessThan(legacyVerboseCatalog.length * 0.5);
  });

  // (d) Always-include tools are ALWAYS Tier 1 (declarations), never demoted
  // to the catalog — even for a message that matches an unrelated category.
  it("always-include tools stay in Tier 1 regardless of message", () => {
    const alwaysInclude = [
      "remember_fact", "recall_memories", "send_gif", "web_search",
      "save_note", "get_mood", "ask_irene",
    ];
    const { tier1, tier2Catalog } = registry.selectByMessage("rob someone for coins", {
      isOwner: true,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    const catalog = catalogNames(tier2Catalog);
    for (const name of alwaysInclude) {
      expect(tier1Names).toContain(name);
      expect(catalog).not.toContain(name);
    }
  });
});

describe("tier-1 cap (Eris)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ownerOpts = {
    isOwner: true,
    everyoneTools: EVERYONE_TOOLS,
    ownerTools: OWNER_TOOLS,
  };

  it("enforces the default cap of 32 on a kitchen-sink message", () => {
    const { tier1 } = registry.selectByMessage(KITCHEN_SINK_MESSAGE, ownerOpts);
    expect(MAX_TIER1_TOOLS).toBe(32);
    // The message matches enough categories to overflow the cap, so the cap
    // binds exactly (this selection measured 75 schemas before the cap).
    expect(tier1.length).toBe(MAX_TIER1_TOOLS);
  });

  // Intent demotion of core tools (toolProfiles.compactTier1ForTurn) happens
  // downstream of the registry; at this layer the always-include core must
  // never lose a slot to keyword-matched tools.
  it("always-include core survives the cap on a kitchen-sink message", () => {
    const { tier1 } = registry.selectByMessage(KITCHEN_SINK_MESSAGE, ownerOpts);
    const tier1Names = new Set(tier1.map((t) => t.name));
    for (const name of [
      "remember_fact", "recall_memories", "web_search", "set_reminder",
      "ask_irene", "get_mood", "send_gif", "configure_feature",
    ]) {
      expect(tier1Names).toContain(name);
    }
  });

  it("capped-out tools land in the Tier-2 catalog and names", () => {
    const { tier1, tier2Catalog, tier2Names } = registry.selectByMessage(
      KITCHEN_SINK_MESSAGE,
      ownerOpts
    );
    const accessible = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name));
    // Completeness invariant: everything the cap dropped is still reachable
    // by exact name (the executor dispatches by name regardless of tier, and
    // dual.js allowlist-checks Tier-2 calls against these names).
    expect(reachableNames(tier1, tier2Catalog)).toEqual(accessible);
    expect(new Set([...tier1.map((t) => t.name), ...tier2Names])).toEqual(accessible);
    expect(tier2Names.length).toBe(accessible.size - tier1.length);
  });

  it("respects TOOLS_TIER1_MAX from the environment", async () => {
    vi.stubEnv("TOOLS_TIER1_MAX", "40");
    vi.resetModules();
    const { registry: freshRegistry, MAX_TIER1_TOOLS: freshMax } =
      await import("../../ai/toolRegistry.js");
    const { EVERYONE_TOOLS: freshEveryone, OWNER_TOOLS: freshOwner } =
      await import("../../ai/tools.js");
    expect(freshMax).toBe(40);
    const { tier1 } = freshRegistry.selectByMessage(KITCHEN_SINK_MESSAGE, {
      isOwner: true,
      everyoneTools: freshEveryone,
      ownerTools: freshOwner,
    });
    expect(tier1.length).toBe(40);
  });

  it("applies a demotion-aware floor so TOOLS_TIER1_MAX=16 actually caps casual turns", async () => {
    vi.stubEnv("TOOLS_TIER1_MAX", "16");
    vi.resetModules();
    const { registry: freshRegistry, MAX_TIER1_TOOLS: freshMax } =
      await import("../../ai/toolRegistry.js");
    const { EVERYONE_TOOLS: freshEveryone, OWNER_TOOLS: freshOwner } =
      await import("../../ai/tools.js");
    expect(freshMax).toBe(16);
    const demotedCores = new Set([
      "ask_irene", "forget_fact", "forget_all",
      "analyze_image", "search_images", "show_image", "send_file",
      "generate_image", "edit_image", "search_meme_templates", "create_meme",
      "save_note", "list_notes", "delete_note", "search_notes",
      "set_reminder", "list_reminders", "cancel_reminder",
      "configure_feature", "list_features", "toggle_twin_chat",
    ]);
    const { tier1, tier2Names } = freshRegistry.selectByMessage("hey just chatting", {
      isOwner: true,
      everyoneTools: freshEveryone,
      ownerTools: freshOwner,
      demotedCores,
    });
    expect(tier1.length).toBeLessThanOrEqual(16);
    const tier1Names = new Set(tier1.map((tool) => tool.name));
    expect(tier1Names).toContain("remember_fact");
    expect(tier1Names).toContain("web_search");
    expect(tier2Names).toContain("ask_irene");
    expect(tier2Names).toContain("create_meme");
  });

  it("lets strong gambling intent beat demoted cores but ignores weak generic game verbs", async () => {
    vi.stubEnv("TOOLS_TIER1_MAX", "16");
    vi.resetModules();
    const { registry: freshRegistry } = await import("../../ai/toolRegistry.js");
    const { EVERYONE_TOOLS: freshEveryone, OWNER_TOOLS: freshOwner } =
      await import("../../ai/tools.js");
    const demotedCores = new Set([
      "ask_irene", "forget_fact", "forget_all",
      "analyze_image", "search_images", "show_image", "send_file",
      "generate_image", "edit_image", "search_meme_templates", "create_meme",
      "save_note", "list_notes", "delete_note", "search_notes",
      "set_reminder", "list_reminders", "cancel_reminder",
      "configure_feature", "list_features", "toggle_twin_chat",
    ]);

    const strong = freshRegistry.selectByMessage("lets play blackjack, bet 500", {
      isOwner: true,
      everyoneTools: freshEveryone,
      ownerTools: freshOwner,
      demotedCores,
    });
    expect(new Set(strong.tier1.map((tool) => tool.name))).toContain("blackjack_start");

    const weak = freshRegistry.selectByMessage("let's play it by ear, when do we start", {
      isOwner: true,
      everyoneTools: freshEveryone,
      ownerTools: freshOwner,
      demotedCores,
    });
    const weakTier1 = new Set(weak.tier1.map((tool) => tool.name));
    expect(weakTier1).not.toContain("blackjack_start");
    expect(weakTier1).not.toContain("slots_spin");
  });

  it("falls back to the default when TOOLS_TIER1_MAX is not a positive integer", async () => {
    vi.stubEnv("TOOLS_TIER1_MAX", "banana");
    vi.resetModules();
    const { MAX_TIER1_TOOLS: freshMax } = await import("../../ai/toolRegistry.js");
    expect(freshMax).toBe(32);
  });
});

describe("shadow cap logging (Eris)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ownerOpts = {
    isOwner: true,
    everyoneTools: EVERYONE_TOOLS,
    ownerTools: OWNER_TOOLS,
  };
  const logMock = vi.mocked(log);
  const shadowLines = () =>
    logMock.mock.calls.filter((call) => String(call[0]).includes("shadow-cap"));

  it("emits one shadow-cap line per selection without changing the selection", () => {
    vi.stubEnv("TOOLS_SHADOW_LOG", "");
    const baseline = registry.selectByMessage(KITCHEN_SINK_MESSAGE, ownerOpts);
    logMock.mockClear();

    vi.stubEnv("TOOLS_SHADOW_LOG", "1");
    const shadowed = registry.selectByMessage(KITCHEN_SINK_MESSAGE, ownerOpts);

    expect(shadowed.tier1.map((t) => t.name)).toEqual(baseline.tier1.map((t) => t.name));
    expect(shadowed.tier2Names).toEqual(baseline.tier2Names);
    expect(shadowed.tier2Catalog).toEqual(baseline.tier2Catalog);
    expect(shadowLines()).toHaveLength(1);
    expect(String(shadowLines()[0][0])).toMatch(/cap16-drops.*cap20-drops/);
  });

  it("logs nothing when TOOLS_SHADOW_LOG is unset", () => {
    vi.stubEnv("TOOLS_SHADOW_LOG", "");
    logMock.mockClear();
    registry.selectByMessage(KITCHEN_SINK_MESSAGE, ownerOpts);
    expect(shadowLines()).toHaveLength(0);
  });
});
