import { describe, it, expect, beforeEach } from "vitest";

import {
  _unknownToolCounts,
  clearUnknownToolCounts,
  pruneUnknownToolCounts,
  recordUnknownTool,
} from "../../ai/unknownTools.js";

beforeEach(() => {
  clearUnknownToolCounts();
});

describe("unknown tool tracker", () => {
  it("increments counters while preserving Map<number> compatibility", () => {
    expect(recordUnknownTool("fake_tool", { now: 1000 })).toBe(1);
    expect(recordUnknownTool("fake_tool", { now: 1001 })).toBe(2);
    expect(_unknownToolCounts.get("fake_tool")).toBe(2);
  });

  it("prunes entries older than the TTL", () => {
    recordUnknownTool("old_tool", { now: 1000, ttlMs: 500 });
    recordUnknownTool("fresh_tool", { now: 1200, ttlMs: 500 });

    const removed = pruneUnknownToolCounts({ now: 1601, ttlMs: 500 });

    expect(removed).toBe(1);
    expect(_unknownToolCounts.has("old_tool")).toBe(false);
    expect(_unknownToolCounts.get("fresh_tool")).toBe(1);
  });

  it("caps high-cardinality hallucinated tool names", () => {
    recordUnknownTool("a", { now: 1000, maxKeys: 2 });
    recordUnknownTool("b", { now: 1001, maxKeys: 2 });
    recordUnknownTool("c", { now: 1002, maxKeys: 2 });

    expect(_unknownToolCounts.has("a")).toBe(false);
    expect(_unknownToolCounts.has("b")).toBe(true);
    expect(_unknownToolCounts.has("c")).toBe(true);
  });
});
