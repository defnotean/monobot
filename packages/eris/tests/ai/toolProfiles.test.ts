import { describe, expect, it } from "vitest";
import { pickToolProfile } from "../../events/messageCreate/toolProfiles.js";
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";

// Pull tool names out of the provider-formatted Tier-1 schemas.
function declNames(schemas: any): Set<string> {
  const names = new Set<string>();
  for (const group of schemas || []) {
    for (const fn of group.functionDeclarations || []) names.add(fn.name);
  }
  return names;
}
function catalogNames(catalog: string): Set<string> {
  const names = new Set<string>();
  for (const line of catalog.split("\n")) {
    const m = line.match(/^- ([a-z0-9_]+):/i);
    if (m) names.add(m[1]);
  }
  return names;
}

describe("pickToolProfile two-tier shape (Eris)", () => {
  it("returns { tier1Schemas (provider-formatted), tier2CatalogText (string) }", () => {
    const r = pickToolProfile({ isTwinMsg: false, isOwner: true, cleanMessage: "hey", channelKey: "c1" });
    expect(r).toHaveProperty("tier1Schemas");
    expect(r).toHaveProperty("tier2CatalogText");
    expect(typeof r.tier2CatalogText).toBe("string");
    // Provider-formatted: array of { functionDeclarations: [...] }
    expect(Array.isArray(r.tier1Schemas)).toBe(true);
    expect(r.tier1Schemas[0]).toHaveProperty("functionDeclarations");
  });

  // COMPLETENESS through the picker: declared Tier-1 names + Tier-2 catalog
  // names must cover every accessible tool. The picker is what the live
  // pipeline calls, so this guards the wiring, not just the registry.
  it("Tier-1 declarations ∪ Tier-2 catalog covers all accessible tools (owner)", () => {
    const { tier1Schemas, tier2CatalogText } = pickToolProfile({
      isTwinMsg: false, isOwner: true, cleanMessage: "hey what's good", channelKey: "c2",
    });
    const reachable = new Set([...declNames(tier1Schemas), ...catalogNames(tier2CatalogText)]);
    const accessible = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name));
    expect(reachable).toEqual(accessible);
  });

  // Token win: Tier-1 declarations are materially fewer than the full set.
  it("Tier-1 declaration count is far smaller than the full tool set", () => {
    const full = new Set([...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name)).size;
    const { tier1Schemas } = pickToolProfile({
      isTwinMsg: false, isOwner: true, cleanMessage: "hey", channelKey: "c3",
    });
    expect(declNames(tier1Schemas).size).toBeLessThan(full * 0.6);
  });
});
