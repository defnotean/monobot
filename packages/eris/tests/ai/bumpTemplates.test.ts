import { describe, it, expect } from "vitest";
// @ts-expect-error
import { _internal } from "../../ai/bumpCelebrations.js";

describe("bumpCelebrations.renderTemplate", () => {
  const { renderTemplate } = _internal;

  it("substitutes known placeholders", () => {
    expect(renderTemplate("streak {streak} hit", { streak: 7 })).toBe("streak 7 hit");
  });

  it("leaves unknown placeholders intact so bad templates fail loudly", () => {
    expect(renderTemplate("hi {unknown}", {})).toBe("hi {unknown}");
  });

  it("substitutes multiple different placeholders", () => {
    expect(renderTemplate("{progress} of {goal}", { progress: 5, goal: 10 })).toBe("5 of 10");
  });

  it("supports the same placeholder appearing multiple times", () => {
    expect(renderTemplate("{name} {name} {name}", { name: "x" })).toBe("x x x");
  });

  it("coerces non-string values", () => {
    expect(renderTemplate("{n}", { n: 42 })).toBe("42");
  });
});
