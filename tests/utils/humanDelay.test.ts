import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import {
  calculateTypingDelay,
  splitHumanReply,
  TYPING_MIN_MS,
  TYPING_MAX_MS,
} from "../../utils/humanDelay.js";

describe("calculateTypingDelay", () => {
  it("is bounded below by TYPING_MIN_MS for trivial inputs", () => {
    for (let i = 0; i < 50; i++) {
      expect(calculateTypingDelay("lol")).toBeGreaterThanOrEqual(TYPING_MIN_MS);
    }
  });

  it("is bounded above by TYPING_MAX_MS even for massive inputs", () => {
    const huge = "x".repeat(5000);
    for (let i = 0; i < 20; i++) {
      expect(calculateTypingDelay(huge)).toBeLessThanOrEqual(TYPING_MAX_MS);
    }
  });

  it("scales roughly with length (long > short on average)", () => {
    let shortSum = 0;
    let longSum = 0;
    for (let i = 0; i < 200; i++) {
      shortSum += calculateTypingDelay("hey whats up");
      longSum  += calculateTypingDelay("hey whats up, honestly been thinking about what you said yesterday and i actually changed my mind about it lol");
    }
    expect(longSum).toBeGreaterThan(shortSum);
  });

  it("returns a positive integer number of ms", () => {
    const d = calculateTypingDelay("test");
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });
});

describe("splitHumanReply", () => {
  it("never splits short replies", () => {
    for (let i = 0; i < 50; i++) {
      expect(splitHumanReply("lol same").length).toBe(1);
      expect(splitHumanReply("thats crazy tho").length).toBe(1);
    }
  });

  it("can split at 'wait' after punctuation when chance=1", () => {
    const text = "yeah i did that earlier. wait actually i didnt finish it lol, my bad";
    let sawSplit = false;
    for (let i = 0; i < 20; i++) {
      const parts = splitHumanReply(text, { chance: 1 });
      if (parts.length === 2) {
        sawSplit = true;
        expect(parts[1].toLowerCase()).toContain("wait");
        // Neither part should be empty
        expect(parts[0].length).toBeGreaterThan(0);
        expect(parts[1].length).toBeGreaterThan(0);
      }
    }
    expect(sawSplit).toBe(true);
  });

  it("never splits mid-sentence", () => {
    // A reply with no valid breakpoints stays whole even at chance=1.
    const text = "this is just one very long sentence that rambles on and on without any breakpoints or split words present in it at all at all";
    for (let i = 0; i < 20; i++) {
      const parts = splitHumanReply(text, { chance: 1 });
      expect(parts.length).toBe(1);
    }
  });

  it("splits on double-newline paragraph structure sometimes", () => {
    const text = "first thought here that is long enough\n\nsecond thought that is also long enough to split";
    let sawMulti = false;
    for (let i = 0; i < 40; i++) {
      const parts = splitHumanReply(text, { chance: 1 });
      if (parts.length >= 2) sawMulti = true;
    }
    expect(sawMulti).toBe(true);
  });

  it("concatenated split segments roughly reconstruct the original (ignoring whitespace)", () => {
    const text = "ok i did it, actually nah i lied, never mind";
    for (let i = 0; i < 30; i++) {
      const parts = splitHumanReply(text, { chance: 1 });
      const rejoined = parts.join(" ").replace(/\s+/g, " ").trim();
      const original = text.replace(/\s+/g, " ").trim();
      expect(rejoined.length).toBe(original.length);
    }
  });
});
