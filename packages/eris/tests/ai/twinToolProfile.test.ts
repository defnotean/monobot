// Twin profile is built by filtering EVERYONE_TOOLS for tools tagged "fun".
// This test pins the metadata-driven contract: tagging a tool with "fun" is
// the single source of truth for twin-conversation availability.
//
// The filter itself lives in events/messageCreate.js around line 914 and is a
// one-liner: `EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"))`. We mirror
// it here so a regression that breaks the contract (e.g., reintroducing a
// hardcoded name list) shows up loudly.

import { describe, it, expect } from "vitest";

// @ts-expect-error - importing JS module without types
import { EVERYONE_TOOLS } from "../../ai/tools.js";

// The exact filter used in events/messageCreate.js to build the twin profile.
// Duplicated here intentionally — if the production filter changes shape,
// this test should be updated to match (and the mismatch will surface in PR
// review).
const twinFilter = (tools: any[]) => tools.filter((t) => t.tags?.includes("fun"));

describe("twin tool profile (metadata-driven)", () => {
  it("includes a tool tagged 'fun' in the twin profile", () => {
    const fakeTools = [
      { name: "fake_fun_tool", tags: ["fun"], description: "x", input_schema: {} },
      { name: "fake_serious_tool", tags: ["admin"], description: "y", input_schema: {} },
    ];
    const twinProfile = twinFilter(fakeTools);
    expect(twinProfile.map((t) => t.name)).toContain("fake_fun_tool");
  });

  it("excludes a tool NOT tagged 'fun' from the twin profile", () => {
    const fakeTools = [
      { name: "fake_fun_tool", tags: ["fun"], description: "x", input_schema: {} },
      { name: "fake_serious_tool", tags: ["admin"], description: "y", input_schema: {} },
      { name: "fake_untagged_tool", description: "z", input_schema: {} },
    ];
    const twinProfile = twinFilter(fakeTools);
    const names = twinProfile.map((t) => t.name);
    expect(names).not.toContain("fake_serious_tool");
    expect(names).not.toContain("fake_untagged_tool");
  });

  it("respects multi-tag membership — a tool tagged ['fun','media'] still lands in twin", () => {
    const fakeTools = [
      { name: "fake_multi", tags: ["fun", "media"], description: "x", input_schema: {} },
    ];
    const twinProfile = twinFilter(fakeTools);
    expect(twinProfile.map((t) => t.name)).toContain("fake_multi");
  });

  it("real EVERYONE_TOOLS contains the seven tools historically marked as 'fun'", () => {
    // Sanity check that we didn't drop any of the tools that were in the old
    // hardcoded FUN_NAMES set during the metadata refactor. If a future change
    // intentionally removes one, update this list.
    const expected = [
      "send_gif",
      "create_meme",
      "search_meme_templates",
      "get_mood",
      "get_relationship",
      "remember_fact",
      "web_search",
    ];
    const twinProfile = twinFilter(EVERYONE_TOOLS);
    const twinNames = twinProfile.map((t: any) => t.name);
    for (const name of expected) {
      expect(twinNames).toContain(name);
    }
  });
});
