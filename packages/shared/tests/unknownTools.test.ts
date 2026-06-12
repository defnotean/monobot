import { describe, expect, it } from "vitest";

import { createUnknownToolTracker } from "../src/ai/unknownTools.js";

describe("unknown tool tracker factory", () => {
  it("creates isolated bounded trackers", () => {
    const first = createUnknownToolTracker();
    const second = createUnknownToolTracker();

    expect(first.recordUnknownTool("fake_tool", { now: 1000 })).toBe(1);
    expect(first.recordUnknownTool("fake_tool", { now: 1001 })).toBe(2);
    expect(second._unknownToolCounts.has("fake_tool")).toBe(false);
  });

  it("prunes by TTL and caps high-cardinality names", () => {
    const tracker = createUnknownToolTracker();

    tracker.recordUnknownTool("old_tool", { now: 1000, ttlMs: 500 });
    tracker.recordUnknownTool("fresh_tool", { now: 1200, ttlMs: 500 });
    expect(tracker.pruneUnknownToolCounts({ now: 1601, ttlMs: 500 })).toBe(1);
    expect(tracker._unknownToolCounts.has("old_tool")).toBe(false);
    expect(tracker._unknownToolCounts.get("fresh_tool")).toBe(1);

    tracker.clearUnknownToolCounts();
    tracker.recordUnknownTool("a", { now: 1000, maxKeys: 2 });
    tracker.recordUnknownTool("b", { now: 1001, maxKeys: 2 });
    tracker.recordUnknownTool("c", { now: 1002, maxKeys: 2 });
    expect([...tracker._unknownToolCounts.keys()]).toEqual(["b", "c"]);
  });
});
