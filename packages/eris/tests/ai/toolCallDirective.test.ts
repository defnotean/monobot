import { describe, expect, it } from "vitest";

// @ts-expect-error JS module without types
import { TOOL_CALL_DIRECTIVE } from "../../events/messageCreate.js";

// The TOOL_CALL_DIRECTIVE is the strongest signal we give the model that
// text-shaped tool calls (e.g. `[tool call: foo]{...}`) and natural-language
// "I did it" confirmations without a real structured call are both forbidden.
// Without this directive at the top of the system prompt, gpt-oss-120b on
// OpenRouter free tier was hallucinating: it'd write "ok turned off events
// in #x" with no structured tool_calls, and the action never ran.
//
// These assertions guard against future edits silently weakening the
// directive (truncation, paraphrase that drops the forbidden examples,
// removal of the "lying" callout).
describe("Eris TOOL_CALL_DIRECTIVE", () => {
  it("is a non-trivial string", () => {
    expect(typeof TOOL_CALL_DIRECTIVE).toBe("string");
    expect(TOOL_CALL_DIRECTIVE.length).toBeGreaterThan(400);
  });

  it("opens with a CRITICAL marker so the model gives it weight", () => {
    expect(TOOL_CALL_DIRECTIVE).toMatch(/CRITICAL\s*[—\-]\s*TOOL CALL PROTOCOL/i);
  });

  it("explicitly demands the structured tool_calls field", () => {
    expect(TOOL_CALL_DIRECTIVE).toMatch(/structured tool call/i);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/tool_calls field/i);
  });

  it("lists every text-shaped format the model has been observed emitting", () => {
    expect(TOOL_CALL_DIRECTIVE).toContain("[tool call: name]");
    expect(TOOL_CALL_DIRECTIVE).toContain("[function call: name]");
    expect(TOOL_CALL_DIRECTIVE).toMatch(/<tool_call>/);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/print\(name\(/);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/name\(\{\.\.\.\}\)/);
  });

  it("explicitly states no action runs when calls are emitted as text", () => {
    expect(TOOL_CALL_DIRECTIVE).toMatch(/NO ACTION HAPPENS/);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/silently fail/i);
  });

  it("forbids confirming an action that wasn't actually called this turn", () => {
    expect(TOOL_CALL_DIRECTIVE).toMatch(/do not confirm/i);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/lying/i);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/didn'?t go through|tool call didn'?t/i);
  });

  it("forbids prose descriptions of pending tool calls", () => {
    expect(TOOL_CALL_DIRECTIVE).toMatch(/don'?t describe a tool call in prose/i);
  });

  it("instructs that the post-call reply should be plain natural language", () => {
    expect(TOOL_CALL_DIRECTIVE).toMatch(/no tool syntax/i);
    expect(TOOL_CALL_DIRECTIVE).toMatch(/short natural-language confirmation/i);
  });
});
