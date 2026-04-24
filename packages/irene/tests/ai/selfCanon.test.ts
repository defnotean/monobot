import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../ai/personality.js", () => {
  const state = { data: { self_facts: [] } };
  return {
    _getData: async () => state.data,
    _markOpinionsDirty: vi.fn(),
    __resetForTest: () => { state.data = { self_facts: [] }; },
  };
});

// @ts-expect-error
import * as selfCanon from "../../ai/selfCanon.js";
import * as personality from "../../ai/personality.js";

beforeEach(() => { (personality as any).__resetForTest(); });

describe("selfCanon.recordSelfFact", () => {
  it("stores a new fact", async () => {
    const r = await selfCanon.recordSelfFact({ fact: "my favorite color is teal" });
    expect(r.ok).toBe(true);
    const facts = await selfCanon.listSelfFacts({});
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe("my favorite color is teal");
  });

  it("rejects empty / whitespace fact", async () => {
    expect((await selfCanon.recordSelfFact({ fact: "" })).ok).toBe(false);
    expect((await selfCanon.recordSelfFact({ fact: "   " })).ok).toBe(false);
  });

  it("rejects facts that are all stopwords", async () => {
    expect((await selfCanon.recordSelfFact({ fact: "the a an" })).ok).toBe(false);
  });

  it("deduplicates similar facts instead of duplicating", async () => {
    await selfCanon.recordSelfFact({ fact: "my favorite color is teal" });
    const r = await selfCanon.recordSelfFact({ fact: "favorite color: teal obviously" });
    expect(r.updated).toBe(true);
    const facts = await selfCanon.listSelfFacts({});
    expect(facts).toHaveLength(1);
  });

  it("respects the MAX_FACTS cap", async () => {
    for (let i = 0; i < 45; i++) {
      await selfCanon.recordSelfFact({ fact: `fact number ${i} unique ${Math.random()}` });
    }
    const facts = await selfCanon.listSelfFacts({});
    expect(facts.length).toBeLessThanOrEqual(40);
  });

  it("filters by category", async () => {
    await selfCanon.recordSelfFact({ fact: "i drink tea not coffee", category: "taste" });
    await selfCanon.recordSelfFact({ fact: "im left handed", category: "identity" });
    const tastes = await selfCanon.listSelfFacts({ category: "taste" });
    expect(tastes).toHaveLength(1);
    expect(tastes[0].fact).toMatch(/tea/);
  });
});

describe("selfCanon.forgetSelfFact", () => {
  it("returns null when nothing matches", async () => {
    const r = await selfCanon.forgetSelfFact("nonexistent");
    expect(r).toBeNull();
  });

  it("removes a fact by keyword match", async () => {
    await selfCanon.recordSelfFact({ fact: "i love pineapple on pizza" });
    const removed = await selfCanon.forgetSelfFact("pineapple");
    expect(removed?.fact).toMatch(/pineapple/);
    expect(await selfCanon.listSelfFacts({})).toHaveLength(0);
  });
});

describe("selfCanon.buildSelfCanonContext", () => {
  it("returns empty string when no facts stored", async () => {
    expect(await selfCanon.buildSelfCanonContext()).toBe("");
  });

  it("returns a YOUR OWN CANON block with all facts", async () => {
    await selfCanon.recordSelfFact({ fact: "my favorite color is teal" });
    await selfCanon.recordSelfFact({ fact: "i hate cilantro" });
    const ctx = await selfCanon.buildSelfCanonContext();
    expect(ctx).toMatch(/YOUR OWN CANON/);
    expect(ctx).toMatch(/teal/);
    expect(ctx).toMatch(/cilantro/);
  });

  it("respects the limit argument", async () => {
    // Use sufficiently distinct facts so the dedupe doesn't collapse them.
    const distinctFacts = [
      "my favorite color is teal",
      "i hate cilantro always",
      "i drink tea instead of coffee",
      "pineapple belongs on pizza fight me",
      "my bedtime is 2am like clockwork",
    ];
    for (const f of distinctFacts) await selfCanon.recordSelfFact({ fact: f });
    const ctx = await selfCanon.buildSelfCanonContext({ limit: 2 });
    const lineCount = (ctx.match(/^\s+-/gm) || []).length;
    expect(lineCount).toBe(2);
  });
});
