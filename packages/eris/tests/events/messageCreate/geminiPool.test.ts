import { describe, it, expect, vi } from "vitest";

// Drive geminiPool with a NON-Gemini provider so it takes the "keep the API
// surface but return null clients" branch — no real GoogleGenAI / keyPool used.
vi.mock("../../../config.js", () => ({
  default: {
    aiProvider: "nvidia",
    geminiKeys: [],
    openaiCompat: { providerName: "OpenRouter" },
  },
}));
vi.mock("@google/genai", () => ({ GoogleGenAI: class {} }));
vi.mock("@defnotean/shared/keyPool", () => ({
  createSplitPools: vi.fn(() => ({ conv: { get: () => ({}) }, work: { get: () => ({}) } })),
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  activeProviderNeedsGeminiClient,
  activeProviderLabel,
  getConvClient,
  getWorkClient,
  // @ts-expect-error - importing JS module without types
} from "../../../events/messageCreate/geminiPool.js";

describe("geminiPool with a non-Gemini provider", () => {
  it("reports that the active provider does NOT need a Gemini client", () => {
    expect(activeProviderNeedsGeminiClient()).toBe(false);
  });

  it("labels nvidia as NVIDIA", () => {
    expect(activeProviderLabel()).toBe("NVIDIA");
  });

  it("returns null clients because the pool was not created for this provider", () => {
    // _geminiPools is {} when provider != gemini, so .conv/.work are undefined.
    expect(getConvClient()).toBe(null);
    expect(getWorkClient()).toBe(null);
  });
});
