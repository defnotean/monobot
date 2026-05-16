import { describe, expect, it } from "vitest";

// @ts-expect-error JS module without types
import { ECONOMY_MUTATING_TOOLS, getEconomyMutatingTools } from "../../ai/toolRegistry.js";
// @ts-expect-error JS module without types
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";

const canonical = ECONOMY_MUTATING_TOOLS as readonly string[];

describe("Canonical economy-mutating tool list", () => {
  it("exposes a non-empty list (at least one tool of each major category)", () => {
    expect(Array.isArray(canonical)).toBe(true);
    expect(canonical.length).toBeGreaterThan(0);
    // The list must cover the four big game/economy categories we mention in
    // the source comment; if any drops to zero, dedup/cache-invalidation in
    // dual.js / executor.js will silently miss a whole feature group.
    const hasGambling = canonical.some((n) => /^(coinflip_bet|dice_roll_bet|slots_spin|blackjack_)/.test(n));
    const hasActivity = canonical.some((n) => ["fish", "hunt", "dig", "work", "beg"].includes(n));
    const hasRewards = canonical.some((n) => /_reward$/.test(n));
    const hasMultiStep = canonical.some((n) => /^(heist_|boss_|adventure_)/.test(n));
    expect(hasGambling, "gambling tools missing").toBe(true);
    expect(hasActivity, "grinding activity tools missing").toBe(true);
    expect(hasRewards, "timed-reward tools missing").toBe(true);
    expect(hasMultiStep, "multi-step heist/boss/adventure tools missing").toBe(true);
  });

  it("contains the well-known core gambling tool names", () => {
    expect(canonical).toContain("coinflip_bet");
    expect(canonical).toContain("slots_spin");
    expect(canonical).toContain("dice_roll_bet");
  });

  it("has no duplicates", () => {
    const seen = new Set<string>();
    for (const name of canonical) {
      expect(seen.has(name), `duplicate entry "${name}" in ECONOMY_MUTATING_TOOLS`).toBe(false);
      seen.add(name);
    }
  });

  it("is frozen — callers must not mutate the canonical source", () => {
    expect(Object.isFrozen(canonical)).toBe(true);
    // A frozen array silently no-ops on push in sloppy mode and throws in
    // strict mode; assert the size stays the same after a push attempt.
    const lenBefore = canonical.length;
    expect(() => {
      (canonical as unknown as string[]).push("definitely_not_a_real_tool");
    }).toThrow();
    expect(canonical.length).toBe(lenBefore);
  });

  it("getEconomyMutatingTools() returns a fresh copy each call", () => {
    const a = getEconomyMutatingTools();
    const b = getEconomyMutatingTools();
    expect(a).toEqual(b);
    // Different array identities — mutating one must not affect the other
    // or the canonical source.
    expect(a).not.toBe(b);
    expect(a).not.toBe(canonical);
    a.push("scribble");
    expect(b).not.toContain("scribble");
    expect(canonical).not.toContain("scribble");
  });

  it("every entry points at a real tool declared in tools.js", () => {
    const declared = new Set(
      [...(EVERYONE_TOOLS as Array<{ name: string }>), ...(OWNER_TOOLS as Array<{ name: string }>)].map((t) => t.name),
    );
    for (const name of canonical) {
      expect(declared.has(name), `ECONOMY_MUTATING_TOOLS entry "${name}" is not declared in tools.js`).toBe(true);
    }
  });

  it("every entry is a valid snake_case tool name", () => {
    for (const name of canonical) {
      expect(name, `bad name shape: ${name}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
