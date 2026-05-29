import { describe, expect, it } from "vitest";
import { ADMIN_TOOLS, EVERYONE_TOOLS } from "../../ai/tools.js";
import { registry } from "../../ai/toolRegistry.js";

// Parse the tool names out of a Tier-2 catalog block. Lines are "- name: desc".
function catalogNames(catalog: string): Set<string> {
  const names = new Set<string>();
  for (const line of catalog.split("\n")) {
    const m = line.match(/^- ([a-z0-9_]+):/i);
    if (m) names.add(m[1]);
  }
  return names;
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
    const reachable = new Set([
      ...tier1.map((t) => t.name),
      ...catalogNames(tier2Catalog),
    ]);
    const accessible = new Set([...ADMIN_TOOLS, ...EVERYONE_TOOLS].map((t) => t.name));
    expect(reachable).toEqual(accessible);
  });

  it("Tier-1 ∪ Tier-2-catalog covers everyone-tools but excludes admin-only for members", () => {
    const { tier1, tier2Catalog } = registry.selectByMessage("hey there", {
      isAdmin: false,
      adminTools: ADMIN_TOOLS,
      everyoneTools: EVERYONE_TOOLS,
    });
    const reachable = new Set([
      ...tier1.map((t) => t.name),
      ...catalogNames(tier2Catalog),
    ]);
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
