import { describe, expect, it } from "vitest";
import {
  buildInnerStateContext,
  compareMemoryPriority,
  normalizeRelationship,
  rankMemoryFact,
  shiftMoodWithInertia,
  shiftRelationship,
} from "../../src/ai/innerState.js";

describe("innerState", () => {
  it("normalizes old relationship rows into the richer shape", () => {
    expect(normalizeRelationship({ affinity_score: 12, interactions_count: 3 })).toMatchObject({
      affinity_score: 12,
      interactions_count: 3,
      trust_score: 0,
      familiarity_score: 0,
      playfulness_score: 0,
      irritation_score: 0,
      respect_score: 0,
    });
  });

  it("updates nuanced relationship dimensions from sentiment", () => {
    const rel = shiftRelationship({}, 2, { sentiment: 0.8, playful: true });
    expect(rel.affinity_score).toBe(2);
    expect(rel.interactions_count).toBe(1);
    expect(rel.trust_score).toBeGreaterThan(0);
    expect(rel.playfulness_score).toBeGreaterThan(rel.irritation_score);
  });

  it("eases mood shifts instead of jumping by the raw delta", () => {
    const mood = shiftMoodWithInertia({ mood_score: 0, energy: 50 }, 30, -10);
    expect(mood.mood_score).toBeGreaterThan(0);
    expect(mood.mood_score).toBeLessThan(30);
    expect(mood.energy).toBe(40);
  });

  it("ranks identity and temporary memories differently", () => {
    expect(rankMemoryFact("my birthday is march 5").importance).toBe("core");
    expect(rankMemoryFact("currently playing ranked tonight").importance).toBe("trivial");
    expect(compareMemoryPriority(
      { fact: "currently playing ranked tonight", importance: "trivial" },
      { fact: "my birthday is march 5", importance: "core" },
    )).toBeLessThan(0);
  });

  it("builds private state instructions without exposing as visible lore", () => {
    const ctx = buildInnerStateContext({
      mood: { mood_score: -45, energy: 20 },
      relationship: { affinity_score: 5, interactions_count: 10, irritation_score: 30 },
      speakerName: "Def",
    });
    expect(ctx).toContain("PRIVATE STATE");
    expect(ctx).toContain("do not mention directly");
    expect(ctx).toContain("Def");
  });
});
