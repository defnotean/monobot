import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { createSelfCanon } from "../../src/ai/selfCanon.js";

// Each test builds its own canon bound to a fresh in-memory store so they
// don't bleed state into each other.
function buildHarness() {
  const state: { data: { self_facts: any[] } } = { data: { self_facts: [] } };
  const markDirty = vi.fn();
  const canon = createSelfCanon({
    getData: async () => state.data,
    markOpinionsDirty: markDirty,
  });
  return { canon, state, markDirty };
}

describe("createSelfCanon — input validation", () => {
  it("throws if getData is missing", () => {
    // @ts-expect-error testing missing arg
    expect(() => createSelfCanon({})).toThrow(/getData function is required/);
  });

  it("works when markOpinionsDirty is omitted", async () => {
    const state = { data: { self_facts: [] as any[] } };
    const canon = createSelfCanon({ getData: async () => state.data });
    const r = await canon.recordSelfFact({ fact: "i drink tea" });
    expect(r.ok).toBe(true);
  });
});

describe("selfCanon.recordSelfFact", () => {
  it("stores a new fact", async () => {
    const { canon } = buildHarness();
    const r = await canon.recordSelfFact({ fact: "my favorite color is teal" });
    expect(r.ok).toBe(true);
    const facts = await canon.listSelfFacts({});
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe("my favorite color is teal");
  });

  it("rejects empty / whitespace fact", async () => {
    const { canon } = buildHarness();
    expect((await canon.recordSelfFact({ fact: "" })).ok).toBe(false);
    expect((await canon.recordSelfFact({ fact: "   " })).ok).toBe(false);
  });

  it("rejects facts that are all stopwords", async () => {
    const { canon } = buildHarness();
    expect((await canon.recordSelfFact({ fact: "the a an" })).ok).toBe(false);
  });

  it("deduplicates similar facts instead of duplicating", async () => {
    const { canon } = buildHarness();
    await canon.recordSelfFact({ fact: "my favorite color is teal" });
    const r = await canon.recordSelfFact({ fact: "favorite color: teal obviously" });
    expect(r.updated).toBe(true);
    const facts = await canon.listSelfFacts({});
    expect(facts).toHaveLength(1);
  });

  it("respects the MAX_FACTS cap", async () => {
    const { canon } = buildHarness();
    for (let i = 0; i < 45; i++) {
      await canon.recordSelfFact({ fact: `fact number ${i} unique ${Math.random()}` });
    }
    const facts = await canon.listSelfFacts({});
    expect(facts.length).toBeLessThanOrEqual(40);
  });

  it("filters by category", async () => {
    const { canon } = buildHarness();
    await canon.recordSelfFact({ fact: "i drink tea not coffee", category: "taste" });
    await canon.recordSelfFact({ fact: "im left handed", category: "identity" });
    const tastes = await canon.listSelfFacts({ category: "taste" });
    expect(tastes).toHaveLength(1);
    expect(tastes[0].fact).toMatch(/tea/);
  });

  it("calls markOpinionsDirty after a successful write", async () => {
    const { canon, markDirty } = buildHarness();
    await canon.recordSelfFact({ fact: "i drink tea" });
    expect(markDirty).toHaveBeenCalled();
  });

  it("returns error when getData returns null", async () => {
    const canon = createSelfCanon({ getData: async () => null });
    const r = await canon.recordSelfFact({ fact: "anything" });
    expect(r.ok).toBe(false);
  });
});

describe("selfCanon.forgetSelfFact", () => {
  it("returns null when nothing matches", async () => {
    const { canon } = buildHarness();
    const r = await canon.forgetSelfFact("nonexistent");
    expect(r).toBeNull();
  });

  it("removes a fact by keyword match", async () => {
    const { canon } = buildHarness();
    await canon.recordSelfFact({ fact: "i love pineapple on pizza" });
    const removed = await canon.forgetSelfFact("pineapple");
    expect(removed?.fact).toMatch(/pineapple/);
    expect(await canon.listSelfFacts({})).toHaveLength(0);
  });
});

describe("selfCanon.buildSelfCanonContext", () => {
  it("returns empty string when no facts stored", async () => {
    const { canon } = buildHarness();
    expect(await canon.buildSelfCanonContext()).toBe("");
  });

  it("returns a YOUR OWN CANON block with all facts", async () => {
    const { canon } = buildHarness();
    await canon.recordSelfFact({ fact: "my favorite color is teal" });
    await canon.recordSelfFact({ fact: "i hate cilantro" });
    const ctx = await canon.buildSelfCanonContext();
    expect(ctx).toMatch(/YOUR OWN CANON/);
    expect(ctx).toMatch(/teal/);
    expect(ctx).toMatch(/cilantro/);
  });

  it("respects the limit argument", async () => {
    const { canon } = buildHarness();
    // Use sufficiently distinct facts so the dedupe doesn't collapse them.
    const distinctFacts = [
      "my favorite color is teal",
      "i hate cilantro always",
      "i drink tea instead of coffee",
      "pineapple belongs on pizza fight me",
      "my bedtime is 2am like clockwork",
    ];
    for (const f of distinctFacts) await canon.recordSelfFact({ fact: f });
    const ctx = await canon.buildSelfCanonContext({ limit: 2 });
    const lineCount = (ctx.match(/^\s+-/gm) || []).length;
    expect(lineCount).toBe(2);
  });
});
