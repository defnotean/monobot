import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROMPT_CHAR_BUDGET,
  applyPromptBudget,
  resolvePromptCharBudget,
} from "../../src/ai/promptBudget.js";

describe("promptBudget", () => {
  it("uses the shared default when no configured budget is provided", () => {
    expect(resolvePromptCharBudget(undefined)).toBe(DEFAULT_PROMPT_CHAR_BUDGET);
    expect(resolvePromptCharBudget(Number.NaN)).toBe(DEFAULT_PROMPT_CHAR_BUDGET);
    expect(resolvePromptCharBudget(0)).toBe(DEFAULT_PROMPT_CHAR_BUDGET);
  });

  it("accepts numeric and string budgets, preserving AI_PROMPT_CHAR_BUDGET config values", () => {
    expect(resolvePromptCharBudget(12000)).toBe(12000);
    expect(resolvePromptCharBudget("12000")).toBe(12000);
  });

  it("returns an under-budget prompt unchanged", () => {
    const prompt = "small prompt";
    expect(applyPromptBudget(prompt, { budget: 100 })).toBe(prompt);
  });

  it("hard-caps an over-budget prompt with no runtime marker", () => {
    const out = applyPromptBudget("x".repeat(150), { budget: 100 });
    expect(out).toHaveLength(100);
  });

  it("trims core text before runtime context when the runtime anchor exists", () => {
    const runtime = "\n\n[Currently speaking: Alice] runtime state";
    const out = applyPromptBudget("C".repeat(120) + runtime, {
      budget: 100,
      minCoreChars: 20,
    });

    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(runtime)).toBe(true);
    expect(out.startsWith("C".repeat(20))).toBe(true);
  });

  it("logs only when budgeting changes the prompt", () => {
    const log = vi.fn();

    applyPromptBudget("small", { budget: 100, log });
    expect(log).not.toHaveBeenCalled();

    applyPromptBudget("x".repeat(150), { budget: 100, log });
    expect(log).toHaveBeenCalledWith("[PERF] Prompt budgeted to 100 chars");
  });

  it("keeps post-budget appendices outside the configured budget", () => {
    const catalog = "\n\nOTHER AVAILABLE TOOLS\n- retained_tool: callable by name";
    const budgeted = applyPromptBudget("C".repeat(120), { budget: 80 });
    const finalPrompt = budgeted + catalog;

    expect(budgeted).toHaveLength(80);
    expect(finalPrompt.length).toBeGreaterThan(80);
    expect(finalPrompt).toContain("retained_tool");
  });
});
