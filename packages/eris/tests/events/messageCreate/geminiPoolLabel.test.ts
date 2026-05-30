import { describe, it, expect, vi } from "vitest";

// hoisted so the vi.mock factory (also hoisted) can reference it safely.
const { createSplitPoolsMock } = vi.hoisted(() => ({
  createSplitPoolsMock: vi.fn(() => ({
    conv: { get: () => "conv-client" },
    work: { get: () => "work-client" },
  })),
}));

// Separate file so we can mock a DIFFERENT provider config without the
// module-cache collision that a single-file two-config setup would cause.
vi.mock("../../../config.js", () => ({
  default: {
    aiProvider: "gemini",
    geminiKeys: ["k1", "k2"],
    openaiCompat: null,
  },
}));
vi.mock("@google/genai", () => ({ GoogleGenAI: class {} }));
vi.mock("@defnotean/shared/keyPool", () => ({
  createSplitPools: createSplitPoolsMock,
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  activeProviderNeedsGeminiClient,
  activeProviderLabel,
  getConvClient,
  getWorkClient,
  // @ts-expect-error - importing JS module without types
} from "../../../events/messageCreate/geminiPool.js";

describe("geminiPool with the Gemini provider active", () => {
  it("reports that a Gemini client IS needed", () => {
    expect(activeProviderNeedsGeminiClient()).toBe(true);
  });

  it("labels gemini as Gemini", () => {
    expect(activeProviderLabel()).toBe("Gemini");
  });

  it("builds split pools from the configured keys at module load", () => {
    expect(createSplitPoolsMock).toHaveBeenCalled();
    const args = createSplitPoolsMock.mock.calls[0];
    expect(args[0]).toBe("gemini");
    expect(args[1]).toEqual(["k1", "k2"]);
  });

  it("returns the pool's conv/work clients", () => {
    expect(getConvClient()).toBe("conv-client");
    expect(getWorkClient()).toBe("work-client");
  });
});
