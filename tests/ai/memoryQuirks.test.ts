import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { getMemoryQuirkHint, _QUIRKS_FOR_TEST } from "../../ai/memoryQuirks.js";

describe("getMemoryQuirkHint", () => {
  it("returns an empty string the overwhelming majority of the time", () => {
    let emitted = 0;
    for (let i = 0; i < 2000; i++) {
      if (getMemoryQuirkHint()) emitted++;
    }
    // Expected ~60 with chance 0.03. Allow wide tolerance to avoid flaky tests.
    expect(emitted).toBeLessThan(200);
  });

  it("returns a real quirk string when chance=1", () => {
    const hint = getMemoryQuirkHint({ chance: 1 });
    expect(hint).toMatch(/\[MEMORY QUIRK:/);
    expect(_QUIRKS_FOR_TEST.some(q => q.text === hint)).toBe(true);
  });

  it("excludes quirks listed in excludeIds", () => {
    for (let i = 0; i < 50; i++) {
      const hint = getMemoryQuirkHint({ chance: 1, excludeIds: ["name_fuzz"] });
      expect(hint).not.toBe(_QUIRKS_FOR_TEST.find(q => q.id === "name_fuzz")?.text);
    }
  });

  it("returns empty when all quirks are excluded", () => {
    const allIds = _QUIRKS_FOR_TEST.map((q: { id: string }) => q.id);
    expect(getMemoryQuirkHint({ chance: 1, excludeIds: allIds })).toBe("");
  });
});
