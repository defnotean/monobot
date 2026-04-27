import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Test the NVIDIA → Gemini fallback behavior in providers/nvidia.js.
// Strategy: stub global fetch to control NVIDIA HTTP responses, then mock
// dual.js so we can assert whether the Gemini fallback path was invoked.

vi.mock("../../ai/dual.js", () => ({
  runGeminiChat: vi.fn(),
}));

// @ts-expect-error — JS module without types
import * as nvidia from "../../ai/providers/nvidia.js";
// @ts-expect-error
import * as dual from "../../ai/dual.js";
// @ts-expect-error
import config from "../../config.js";

const realFetch = globalThis.fetch;

function mockNvidiaResponse(status: number, body: any = "") {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body || "{}") : body),
  })) as any;
}

const baseArgs = (): [any, string, any[], any[], string, any, any] => [
  null, // _client
  "you are a test bot",
  [], // tools
  [{ role: "user", parts: [{ text: "hi" }] }],
  "hi", // userMessage
  vi.fn(async () => "tool result"),
  { useFastModel: true },
];

beforeEach(() => {
  (dual.runGeminiChat as any).mockReset();
  if (!config.geminiKeys?.length) (config as any).geminiKeys = ["test-fallback-key"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("NVIDIA → Gemini fallback (Eris)", () => {
  it("falls back to Gemini when NVIDIA returns 503", async () => {
    mockNvidiaResponse(503, "Service Unavailable");
    (dual.runGeminiChat as any).mockResolvedValue({
      text: "fallback worked",
      toolsUsed: [],
      functionCalls: [],
    });

    const result = await nvidia.runGeminiChat(...baseArgs());

    expect(dual.runGeminiChat).toHaveBeenCalledOnce();
    expect(result.text).toBe("fallback worked");
  });

  it("returns the user-friendly error when both NVIDIA and Gemini fail", async () => {
    mockNvidiaResponse(503, "Service Unavailable");
    (dual.runGeminiChat as any).mockRejectedValue(new Error("Gemini also down"));

    const result = await nvidia.runGeminiChat(...baseArgs());

    expect(dual.runGeminiChat).toHaveBeenCalledOnce();
    expect(result.text).toContain("having trouble thinking");
  });

  it("does NOT fall back on 401 auth errors", async () => {
    mockNvidiaResponse(401, "Unauthorized");

    const result = await nvidia.runGeminiChat(...baseArgs());

    expect(dual.runGeminiChat).not.toHaveBeenCalled();
    expect(result.text).toContain("having trouble thinking");
  });

  it("does NOT fall back when GEMINI_API_KEY is empty", async () => {
    const savedKeys = config.geminiKeys;
    (config as any).geminiKeys = [];
    mockNvidiaResponse(503, "Service Unavailable");

    const result = await nvidia.runGeminiChat(...baseArgs());

    expect(dual.runGeminiChat).not.toHaveBeenCalled();
    expect(result.text).toContain("having trouble thinking");
    (config as any).geminiKeys = savedKeys;
  });
});
