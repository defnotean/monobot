import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../../utils/logger.js";
import { ADMIN_TOOLS, EVERYONE_TOOLS } from "../../ai/tools.js";
import { MAX_TIER1_TOOLS, registry } from "../../ai/toolRegistry.js";

// Capture registry log lines (shadow-cap telemetry assertions below) while
// keeping the rest of the logger surface intact.
vi.mock("../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/logger.js")>();
  return { ...actual, log: vi.fn() };
});

// Keyword-rich message that matches many categories at once — the worst-case
// selection shape the cap exists to bound.
const KITCHEN_SINK_MESSAGE =
  "ban role channel ticket birthday vc music level invite server log youtube " +
  "twitch github giveaway emoji thread search messages";

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
  it("registers every declared Irene AI tool", () => {
    const declared = new Set([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((tool) => tool.name));
    const registered = new Set(registry.getAllToolNames());

    expect(registered).toEqual(declared);
  });

  it("keeps always-included core tools selectable", () => {
    const { tier1 } = registry.selectByMessage("", {
      isAdmin: true,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const tier1Names = new Set(tier1.map((tool) => tool.name));

    expect(tier1Names).toContain("remember_fact");
    expect(tier1Names).toContain("web_search");
    expect(tier1Names).toContain("ask_eris");
  });
});

describe("two-tier selection (Irene)", () => {
  // (a) COMPLETENESS — every accessible tool must appear in Tier 1 (schema)
  // OR the Tier-2 catalog (by name). Nothing may be unreachable.
  it("Tier-1 ∪ Tier-2-catalog covers the full accessible tool set (admin)", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey there", {
      isAdmin: true,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const reachable = reachableNames(tier1, tier2Catalog);
    const accessible = new Set([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t) => t.name));
    expect(reachable).toEqual(accessible);
  });

  it("Tier-1 ∪ Tier-2-catalog covers everyone-tools but excludes admin-only for members", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey there", {
      isAdmin: false,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const reachable = reachableNames(tier1, tier2Catalog);
    const everyoneNames = new Set(EVERYONE_TOOLS.map((t) => t.name));
    for (const name of everyoneNames) expect(reachable).toContain(name);
    const adminOnly = ADMIN_TOOLS.map((t) => t.name).filter((n) => !everyoneNames.has(n));
    for (const name of adminOnly) expect(reachable).not.toContain(name);
  });

  // (b) A message with a category keyword pulls that category into Tier 1.
  it("routes a moderation-keyword message to the moderation category in Tier 1", () => {
    const { tier1 } = registry.selectByMessage("ban that user and purge their messages", {
      isAdmin: true,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    expect(tier1Names).toContain("ban_user");
    expect(tier1Names).toContain("purge_messages");
  });

  it("routes a music-keyword message to the music category in Tier 1", () => {
    const { tier1 } = registry.selectByMessage("play some music", {
      isAdmin: false,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    expect(tier1Names).toContain("play_music");
    expect(tier1Names).toContain("skip_song");
  });

  // (c) Tier-1 is materially smaller than the full set — the token win.
  it("Tier-1 schema count is far smaller than the full tool set", () => {
    const full = new Set([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t) => t.name)).size;
    const { tier1 } = registry.selectByMessage("hey", {
      isAdmin: true,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    expect(tier1.length).toBeLessThan(full * 0.6);
  });

  it("bounds Tier-1 schemas even when a message matches many categories", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage(
      "ban role channel ticket birthday vc music level invite server log youtube twitch github giveaway emoji thread search messages",
      {
        isAdmin: true,
        adminTools: ADMIN_TOOLS,
        everyoneTools: EVERYONE_TOOLS,
      }
    );
    const accessible = new Set([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t) => t.name));

    expect(tier1.length).toBeLessThanOrEqual(MAX_TIER1_TOOLS);
    expect(reachableNames(tier1, tier2Catalog)).toEqual(accessible);
  });

  it("uses a compact grouped Tier-2 catalog instead of per-tool descriptions", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey there", {
      isAdmin: true,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const tier2Names = catalogNames(tier2Catalog);
    const byName = new Map([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((tool) => [tool.name, tool]));
    const legacyVerboseCatalog =
      "\n\nOTHER AVAILABLE TOOLS (you can call these by name — just use the tool name and provide the required arguments):\n" +
      [...tier2Names]
        .map((name) => `- ${name}: ${(byName.get(name)?.description || "").split(/\.\s/)[0]}`)
        .join("\n");

    expect(tier1.length).toBeLessThanOrEqual(MAX_TIER1_TOOLS);
    expect(tier2Names.size).toBeGreaterThan(100);
    expect(tier2Catalog.length).toBeLessThan(legacyVerboseCatalog.length * 0.35);
  });

  // (d) Always-include tools are ALWAYS Tier 1, never demoted to the catalog.
  it("always-include tools stay in Tier 1 regardless of message", () => {
    const alwaysInclude = [
      "remember_fact", "recall_memories", "send_gif", "web_search",
      "calculate", "ask_eris", "reminder_set",
    ];
    const { tier1, tier2Catalog } = registry.selectByMessage("ban someone", {
      isAdmin: true,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    const catalog = catalogNames(tier2Catalog);
    for (const name of alwaysInclude) {
      expect(tier1Names).toContain(name);
      expect(catalog).not.toContain(name);
    }
  });
});

describe("tier-1 cap (Irene)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const adminOpts = {
    isAdmin: true,
    adminTools: ADMIN_TOOLS,
    everyoneTools: EVERYONE_TOOLS,
  };

  it("enforces the default cap of 32 on a kitchen-sink message", () => {
    const { tier1 } = registry.selectByMessage(KITCHEN_SINK_MESSAGE, adminOpts);
    expect(MAX_TIER1_TOOLS).toBe(32);
    expect(tier1.length).toBeLessThanOrEqual(MAX_TIER1_TOOLS);
  });

  it("capped-out tools land in the Tier-2 catalog and names", () => {
    const { tier1, tier2Catalog, tier2Names } = registry.selectByMessage(
      KITCHEN_SINK_MESSAGE,
      adminOpts
    );
    const accessible = new Set([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t) => t.name));
    // Completeness invariant: everything the cap dropped is still reachable
    // by exact name (the executor dispatches by name regardless of tier, and
    // the Tier-2 allowlist is built from these names).
    expect(reachableNames(tier1, tier2Catalog)).toEqual(accessible);
    expect(new Set([...tier1.map((t) => t.name), ...tier2Names])).toEqual(accessible);
    expect(tier2Names.length).toBe(accessible.size - tier1.length);
  });

  it("respects TOOLS_TIER1_MAX from the environment", async () => {
    vi.stubEnv("TOOLS_TIER1_MAX", "20");
    vi.resetModules();
    const { registry: freshRegistry, MAX_TIER1_TOOLS: freshMax } =
      await import("../../ai/toolRegistry.js");
    const { ADMIN_TOOLS: freshAdmin, EVERYONE_TOOLS: freshEveryone } =
      await import("../../ai/tools.js");
    expect(freshMax).toBe(20);
    const { tier1 } = freshRegistry.selectByMessage(KITCHEN_SINK_MESSAGE, {
      isAdmin: true,
      adminTools: freshAdmin,
      everyoneTools: freshEveryone,
    });
    expect(tier1.length).toBeLessThanOrEqual(
      Math.max(20, freshRegistry.getStats().alwaysInclude)
    );
    expect(tier1.length).toBeLessThan(MAX_TIER1_TOOLS);
    // Always-include core survives the tighter cap.
    const tier1Names = new Set(tier1.map((t) => t.name));
    for (const name of ["remember_fact", "web_search", "ask_eris", "reminder_set"]) {
      expect(tier1Names).toContain(name);
    }
  });

  it("falls back to the default when TOOLS_TIER1_MAX is not a positive integer", async () => {
    vi.stubEnv("TOOLS_TIER1_MAX", "-3");
    vi.resetModules();
    const { MAX_TIER1_TOOLS: freshMax } = await import("../../ai/toolRegistry.js");
    expect(freshMax).toBe(32);
  });
});

describe("shadow cap logging (Irene)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const adminOpts = {
    isAdmin: true,
    adminTools: ADMIN_TOOLS,
    everyoneTools: EVERYONE_TOOLS,
  };
  const logMock = vi.mocked(log);
  const shadowLines = () =>
    logMock.mock.calls.filter((call) => String(call[0]).includes("shadow-cap"));

  it("emits one shadow-cap line per selection without changing the selection", () => {
    vi.stubEnv("TOOLS_SHADOW_LOG", "");
    const baseline = registry.selectByMessage(KITCHEN_SINK_MESSAGE, adminOpts);
    logMock.mockClear();

    vi.stubEnv("TOOLS_SHADOW_LOG", "1");
    const shadowed = registry.selectByMessage(KITCHEN_SINK_MESSAGE, adminOpts);

    expect(shadowed.tier1.map((t) => t.name)).toEqual(baseline.tier1.map((t) => t.name));
    expect(shadowed.tier2Names).toEqual(baseline.tier2Names);
    expect(shadowed.tier2Catalog).toEqual(baseline.tier2Catalog);
    expect(shadowLines()).toHaveLength(1);
    expect(String(shadowLines()[0][0])).toMatch(/cap16-drops.*cap20-drops/);
  });

  it("logs nothing when TOOLS_SHADOW_LOG is unset", () => {
    vi.stubEnv("TOOLS_SHADOW_LOG", "");
    logMock.mockClear();
    registry.selectByMessage(KITCHEN_SINK_MESSAGE, adminOpts);
    expect(shadowLines()).toHaveLength(0);
  });
});
