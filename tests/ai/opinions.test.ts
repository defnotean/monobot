import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the personality module so we don't touch Supabase/config in unit tests.
// _getData returns a fresh data object per test, and _markOpinionsDirty is a spy.
vi.mock("../../ai/personality.js", () => {
  const state = { data: { opinions: [] } };
  return {
    _getData: async () => state.data,
    _markOpinionsDirty: vi.fn(),
    // Test helper — the mock module exposes this so tests can reset between runs.
    __resetForTest: () => { state.data = { opinions: [] }; },
    __getInternal: () => state.data,
  };
});

// @ts-expect-error - importing JS module without types
import * as opinions from "../../ai/opinions.js";
import * as personality from "../../ai/personality.js";

const { _internal } = opinions;

beforeEach(async () => {
  // @ts-expect-error - test-only export from mock
  personality.__resetForTest();
});

describe("opinions tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(_internal.tokenize("Pineapple, PIZZA!!!")).toEqual(["pineapple", "pizza"]);
  });
  it("drops stopwords and ultra-short tokens", () => {
    expect(_internal.tokenize("i think the new arcane season is good")).toEqual(["think", "new", "arcane", "season", "good"]);
  });
});

describe("opinions overlapRatio", () => {
  it("returns 0 for disjoint sets", () => {
    expect(_internal.overlapRatio(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("returns 1 for identical sets", () => {
    expect(_internal.overlapRatio(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("normalizes by the larger set", () => {
    expect(_internal.overlapRatio(new Set(["a", "b"]), new Set(["a", "b", "c", "d"]))).toBeCloseTo(0.5);
  });
});

describe("opinions recordOpinion", () => {
  it("stores a new opinion", async () => {
    const r = await opinions.recordOpinion({ topic: "pineapple pizza", stance: "negative", reason: "fruit doesnt belong there" });
    expect(r.ok).toBe(true);
    const list = await opinions.listRecentOpinions({});
    expect(list).toHaveLength(1);
    expect(list[0].stance).toBe("negative");
    expect(list[0].topic).toBe("pineapple pizza");
  });

  it("rejects missing topic or stance", async () => {
    expect((await opinions.recordOpinion({ topic: "", stance: "positive" })).ok).toBe(false);
    expect((await opinions.recordOpinion({ topic: "foo" })).ok).toBe(false);
  });

  it("rejects topics that are all stopwords", async () => {
    const r = await opinions.recordOpinion({ topic: "the a", stance: "positive" });
    expect(r.ok).toBe(false);
  });

  it("deduplicates by topic-word overlap", async () => {
    await opinions.recordOpinion({ topic: "pineapple pizza", stance: "negative" });
    await opinions.recordOpinion({ topic: "pineapple PIZZA!!!", stance: "negative" });
    const list = await opinions.listRecentOpinions({});
    expect(list).toHaveLength(1);
  });

  it("flags a stance flip and preserves previous stance", async () => {
    await opinions.recordOpinion({ topic: "arcane", stance: "negative" });
    const r = await opinions.recordOpinion({ topic: "arcane", stance: "positive", reason: "season 2 changed my mind" });
    expect(r.flipped).toBe(true);
    const list = await opinions.listRecentOpinions({ topic: "arcane" });
    expect(list[0].stance).toBe("positive");
    expect(list[0].previousStance).toBe("negative");
    expect(list[0].flippedAt).toBeTruthy();
  });

  it("normalizes stance synonyms", async () => {
    await opinions.recordOpinion({ topic: "valorant", stance: "love" });
    const list = await opinions.listRecentOpinions({ topic: "valorant" });
    expect(list[0].stance).toBe("positive");
  });
});

describe("opinions findRelatedOpinions", () => {
  beforeEach(async () => {
    await opinions.recordOpinion({ topic: "pineapple pizza", stance: "negative" });
    await opinions.recordOpinion({ topic: "valorant ranked", stance: "positive" });
    await opinions.recordOpinion({ topic: "the new arcane season", stance: "positive" });
  });

  it("finds a related opinion by keyword overlap", async () => {
    const r = await opinions.findRelatedOpinions("whats your take on valorant");
    expect(r).toHaveLength(1);
    expect(r[0].topic).toBe("valorant ranked");
  });

  it("returns empty when no overlap", async () => {
    const r = await opinions.findRelatedOpinions("what color is the sky");
    expect(r).toEqual([]);
  });

  it("returns empty on empty message", async () => {
    expect(await opinions.findRelatedOpinions("")).toEqual([]);
  });

  it("respects the limit argument", async () => {
    await opinions.recordOpinion({ topic: "pineapple smoothie", stance: "positive" });
    const r = await opinions.findRelatedOpinions("pineapple stuff", 1);
    expect(r).toHaveLength(1);
  });
});

describe("opinions buildOpinionContext", () => {
  it("returns empty string when no related opinions", async () => {
    expect(await opinions.buildOpinionContext("the sky is blue")).toBe("");
  });

  it("produces a context string containing the stored stance", async () => {
    await opinions.recordOpinion({ topic: "pineapple pizza", stance: "negative" });
    const ctx = await opinions.buildOpinionContext("i love pineapple pizza");
    expect(ctx).toContain("pineapple pizza");
    expect(ctx).toContain("negative");
    expect(ctx).toMatch(/PRIOR TAKES/);
  });

  it("surfaces flip history when the stance changed", async () => {
    await opinions.recordOpinion({ topic: "arcane", stance: "negative" });
    await opinions.recordOpinion({ topic: "arcane", stance: "positive" });
    const ctx = await opinions.buildOpinionContext("did you watch arcane");
    expect(ctx).toMatch(/used to be negative/);
  });
});
