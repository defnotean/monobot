import { describe, it, expect } from "vitest";

// @ts-expect-error - importing JS module without types
import { computeTurnBudget } from "../../../events/messageCreate/turnBudget.js";

const run = (cleanMessage: string, isOwner = false, authorId = "1") =>
  computeTurnBudget({ cleanMessage, isOwner, authorId });

describe("computeTurnBudget — defaults & identity", () => {
  it("uses the 250-char default budget for ordinary chat", () => {
    const { charBudget, suffix } = run("just hanging out today");
    expect(charBudget).toBe(250);
    expect(suffix).toContain("LENGTH BUDGET");
    expect(suffix).toContain("250 characters");
  });

  it("always appends the identity reminder", () => {
    expect(run("hi").suffix).toContain("YOU ARE ERIS");
  });

  it("does not add the mandatory-search block for a plain greeting", () => {
    expect(run("hey what's up").suffix).not.toContain("MANDATORY_SEARCH");
  });

  it("does not add the search block for a music share", () => {
    expect(run("here's my spotify check it out").suffix).not.toContain("MANDATORY_SEARCH");
  });
});

describe("computeTurnBudget — research lane", () => {
  it("flags a factual question and bumps the budget to 400", () => {
    const { suffix, charBudget } = run("how many moons does jupiter have?");
    expect(suffix).toContain("MANDATORY_SEARCH");
    expect(charBudget).toBe(400);
  });

  it("flags a wh-question with a question mark", () => {
    expect(run("which language is fastest for this?").suffix).toContain("MANDATORY_SEARCH");
  });

  it("flags a factual challenge even without a question mark", () => {
    expect(run("youre wrong, look it up").suffix).toContain("MANDATORY_SEARCH");
  });

  it("flags study/homework context", () => {
    expect(run("this is for my chapter 3 homework quiz").suffix).toContain("MANDATORY_SEARCH");
  });

  it("does NOT flag too-short messages even if they look factual", () => {
    expect(run("who?").suffix).not.toContain("MANDATORY_SEARCH");
  });
});

describe("computeTurnBudget — vent lane", () => {
  it("gives the larger 600-char budget for venting", () => {
    const { charBudget } = run("im sad and had a bad day");
    expect(charBudget).toBe(600);
  });

  it("vent budget wins even when not a research message", () => {
    expect(run("i feel like venting rn").charBudget).toBe(600);
  });
});

describe("computeTurnBudget — owner whitelist force", () => {
  it("adds the mandatory whitelist-action block only for the owner + whitelist verb", () => {
    const owner = run("remove jett from the whitelist", true, "owner-123");
    expect(owner.suffix).toContain("MANDATORY_WHITELIST_ACTION");
    // The exact author id is interpolated into the directive.
    expect(owner.suffix).toContain("owner-123");
  });

  it("does NOT add the whitelist block for a non-owner", () => {
    expect(run("remove jett from the whitelist", false, "rando").suffix)
      .not.toContain("MANDATORY_WHITELIST_ACTION");
  });

  it("does NOT add the whitelist block for the owner without a whitelist verb", () => {
    expect(run("what's the weather like", true, "owner-123").suffix)
      .not.toContain("MANDATORY_WHITELIST_ACTION");
  });
});
