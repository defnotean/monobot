// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted runs before the (also-hoisted) vi.mock factories, so the spies are
// safe to reference inside them (avoids the "Cannot access ... before
// initialization" hoisting error).
const h = vi.hoisted(() => ({
  setRateLimitCallbacks: vi.fn(),
  createSplitPools: vi.fn(() => ({})),
}));

// Drive the provider-detection branches via config. aiProvider is non-gemini
// here, so the module-load side effect must NOT create any key pools.
vi.mock("../../../config.js", () => ({
  default: { aiProvider: "openai", openaiCompat: { providerName: "TogetherAI" } },
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../ai/providers/index.js", () => ({
  runGeminiChat: vi.fn(),
  quickReply: vi.fn(),
  looksLikeTask: vi.fn(() => true),
  setRateLimitCallbacks: h.setRateLimitCallbacks,
}));
vi.mock("@defnotean/shared/keyPool", () => ({ createSplitPools: h.createSplitPools }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class {} }));

import {
  activeProviderNeedsGeminiClient,
  activeProviderLabel,
  PROMPT_BUDGET,
  applyPromptBudget,
  wireRateLimitCallbacks,
  getConvClient,
  hasWorkPool,
} from "../../../events/messageCreate/aiInvoke.js";

beforeEach(() => vi.clearAllMocks());

describe("aiInvoke / provider detection", () => {
  it("activeProviderNeedsGeminiClient is false for a non-gemini provider", () => {
    expect(activeProviderNeedsGeminiClient()).toBe(false);
  });

  it("activeProviderLabel prefers the openaiCompat provider name", () => {
    expect(activeProviderLabel()).toBe("TogetherAI");
  });

  it("does not create gemini key pools when the provider is not gemini", () => {
    // Module-load side effect: createSplitPools must NOT have run.
    expect(h.createSplitPools).not.toHaveBeenCalled();
    expect(getConvClient()).toBeNull();
    expect(hasWorkPool()).toBe(false);
  });
});

describe("aiInvoke / applyPromptBudget", () => {
  it("returns the prompt unchanged when under budget", () => {
    const p = "small prompt";
    expect(applyPromptBudget(p)).toBe(p);
  });

  it("hard-caps an over-budget prompt with no runtime marker", () => {
    const huge = "x".repeat(PROMPT_BUDGET + 5000);
    const out = applyPromptBudget(huge);
    expect(out.length).toBe(PROMPT_BUDGET);
  });

  it("preserves the runtime block when trimming the core personality", () => {
    const runtime = "\n\n[Currently speaking: Alice] some runtime state here";
    const core = "C".repeat(PROMPT_BUDGET); // forces over-budget
    const out = applyPromptBudget(core + runtime);
    expect(out.length).toBeLessThanOrEqual(PROMPT_BUDGET);
    expect(out.endsWith(runtime)).toBe(true); // runtime kept intact at the end
  });
});

describe("aiInvoke / wireRateLimitCallbacks", () => {
  it("wires null callbacks when the active provider is not gemini", () => {
    wireRateLimitCallbacks(false);
    expect(h.setRateLimitCallbacks).toHaveBeenCalledTimes(1);
    expect(h.setRateLimitCallbacks).toHaveBeenCalledWith(null, null);
  });
});
