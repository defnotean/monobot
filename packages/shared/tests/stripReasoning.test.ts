import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module without .d.ts; types not needed here.
import { stripReasoning } from "../src/ai/stripReasoning.js";

describe("stripReasoning", () => {
  it("removes a closed <think> block and keeps the reply", () => {
    expect(stripReasoning("<think>the user wants a joke. plan one.</think>why did the bot cross the road")).toBe(
      "why did the bot cross the road",
    );
  });

  it("removes multiple blocks, case-insensitively, across lines", () => {
    const input = "<THINK>first\nplan</THINK>part one <Think>second\nplan</thinK> part two";
    expect(stripReasoning(input)).toBe("part one  part two".trim());
    expect(stripReasoning(input)).not.toContain("plan");
  });

  it("strips an unclosed <think> block (truncated output) to end-of-string", () => {
    expect(stripReasoning("here you go <think>wait, actually I should reconsider the")).toBe("here you go");
  });

  it("returns empty string for a think-only truncated response (unclosed at position 0)", () => {
    expect(stripReasoning("<think>all reasoning, no answer, cut off by max_tok")).toBe("");
  });

  it("returns empty string for a closed think-only response", () => {
    expect(stripReasoning("<think>pure reasoning</think>")).toBe("");
    expect(stripReasoning("  <think>pure reasoning</think>  ")).toBe("");
  });

  it("returns text unchanged (trimmed) when there is no think block", () => {
    expect(stripReasoning("  just a normal reply  ")).toBe("just a normal reply");
    expect(stripReasoning("a reply that merely mentions thinking")).toBe("a reply that merely mentions thinking");
  });

  it("strips a closed block followed by an unclosed one", () => {
    expect(stripReasoning("<think>a</think>answer<think>trailing cut-off reasoning")).toBe("answer");
  });

  it("strips an orphan closing </think> (prompt pre-filled the opener)", () => {
    // DeepSeek-R1 serving templates that pre-fill <think> leave only the
    // reasoning + a lone closing tag in content.
    expect(stripReasoning("the user asked X. I should answer politely.</think>Sure, here you go!")).toBe(
      "Sure, here you go!",
    );
  });

  it("orphan-close form across multiple lines keeps only the post-tag reply", () => {
    const input = "reasoning line one\nreasoning line two\n</think>\nfinal answer";
    expect(stripReasoning(input)).toBe("final answer");
    expect(stripReasoning(input)).not.toContain("reasoning");
  });

  it("does not treat a closed block's own </think> as an orphan", () => {
    // Regression: the closed-block pass runs first, so a normal closed block
    // must NOT trip the orphan-close branch and eat the real reply.
    expect(stripReasoning("<think>plan</think>real reply")).toBe("real reply");
  });

  it("handles non-string and empty input", () => {
    expect(stripReasoning(null)).toBe("");
    expect(stripReasoning(undefined)).toBe("");
    expect(stripReasoning("")).toBe("");
    expect(stripReasoning(42)).toBe("");
  });
});
