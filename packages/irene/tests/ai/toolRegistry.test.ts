import { describe, expect, it } from "vitest";
import { ADMIN_TOOLS, EVERYONE_TOOLS } from "../../ai/tools.js";
import { registry } from "../../ai/toolRegistry.js";

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
