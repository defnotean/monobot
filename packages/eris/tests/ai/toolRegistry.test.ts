import { describe, expect, it } from "vitest";
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";
import { registry } from "../../ai/toolRegistry.js";

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
  it("routes a gambling-keyword message to the games category in Tier 1", () => {
    const { tier1 } = registry.selectByMessage("eris slots spin pls", {
      isOwner: false,
      everyoneTools: EVERYONE_TOOLS,
      ownerTools: OWNER_TOOLS,
    });
    const tier1Names = new Set(tier1.map((t) => t.name));
    expect(tier1Names).toContain("slots_spin");
    expect(tier1Names).toContain("blackjack_start");
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
