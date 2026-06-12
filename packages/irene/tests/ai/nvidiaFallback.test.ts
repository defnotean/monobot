import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Test the NVIDIA → Gemini fallback behavior in providers/nvidia.js.
// Strategy: stub global fetch to control NVIDIA HTTP responses, then mock
// dual.js so we can assert whether the Gemini fallback path was invoked.

vi.mock("../../ai/dual.js", () => ({
  runGeminiChat: vi.fn(),
}));

// executor.js is imported by nvidia.js — stub the global executor so the
// test doesn't pull the entire tool surface into the process. postDeferralIfNeeded
// is the destructive-action confirm render bridge nvidia.js now calls on every
// tool result; stub it as a passthrough so string results flow through unchanged.
vi.mock("../../ai/executor.js", () => ({
  executeTool: vi.fn(async () => "stubbed"),
  postDeferralIfNeeded: vi.fn(async (result: unknown) => result),
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

function successBody(text = "ok") {
  return {
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

async function runBasicNvidiaChat(overrides: Record<string, any> = {}) {
  return await nvidia.runGeminiChat({
    geminiClient: null,
    systemInstruction: "you are a test bot",
    history: [{ role: "user", parts: [{ text: "hi" }] }],
    tools: [],
    message: { userMessage: "hi" },
    isAdmin: false,
    useFastModel: true,
    ...overrides,
  });
}

async function resetNvidiaBreaker() {
  nvidia.setRateLimitCallbacks(null, null);
  mockNvidiaResponse(200, successBody("breaker reset"));
  await runBasicNvidiaChat();
  nvidia.setRateLimitCallbacks(null, null);
}

beforeEach(async () => {
  (dual.runGeminiChat as any).mockReset();
  // Ensure at least one Gemini key is present (test setup defines GEMINI_API_KEY)
  if (!config.geminiKeys?.length) (config as any).geminiKeys = ["test-fallback-key"];
  await resetNvidiaBreaker();
});

afterEach(() => {
  nvidia.setRateLimitCallbacks(null, null);
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("NVIDIA → Gemini fallback (Irene)", () => {
  it("sends Kimi K2.6 NVIDIA settings with balanced tool judgment", async () => {
    const savedNvidia = { ...config.nvidia };
    Object.assign(config.nvidia, {
      apiKey: "test-nvidia-key",
      model: "moonshotai/kimi-k2.6",
      fastModel: "moonshotai/kimi-k2.6",
      maxTokens: 16384,
      temperature: 1,
      topP: 1,
      thinking: true,
      toolStrictness: "balanced",
    });
    mockNvidiaResponse(200, {
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });

    const result = await nvidia.runGeminiChat({
      geminiClient: null,
      systemInstruction: "you are a test bot",
      history: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{
        name: "web_search",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      }],
      message: { userMessage: "hi" },
      isAdmin: false,
      useFastModel: false,
    });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(result.text).toBe("ok");
    expect(init.headers.Authorization).toBe("Bearer test-nvidia-key");
    expect(body.model).toBe("moonshotai/kimi-k2.6");
    expect(body.max_tokens).toBe(16384);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, thinking: true });
    expect(body.tool_choice).toBe("auto");
    expect(body.tools[0].function.name).toBe("web_search");
    expect(body.messages[0].content).toContain("[BALANCED TOOL JUDGMENT]");

    Object.assign(config.nvidia, savedNvidia);
  });

  it("routes catalog-only tools through use_tool", async () => {
    const responses = [
      {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "c1",
              function: {
                name: "use_tool",
                arguments: JSON.stringify({ tool_name: "list_channels", arguments: { include_hidden: false } }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
      {
        choices: [{ message: { role: "assistant", content: "listed them" }, finish_reason: "stop" }],
      },
    ];
    let i = 0;
    globalThis.fetch = vi.fn(async () => {
      const body = responses[Math.min(i++, responses.length - 1)];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as any;
    }) as any;
    const executor = vi.fn(async () => "channel list");

    const result = await nvidia.runGeminiChat({
      geminiClient: null,
      systemInstruction: "you are a test bot",
      history: [{ role: "user", parts: [{ text: "show channels" }] }],
      tools: [],
      message: { userMessage: "show channels" },
      executor,
      isAdmin: true,
      routerToolNames: ["list_channels"],
    });
    const firstBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);

    expect(firstBody.tools.map((tool: any) => tool.function.name)).toContain("use_tool");
    expect(executor).toHaveBeenCalledWith("list_channels", { include_hidden: false });
    expect(result).toEqual({ text: "listed them", toolsUsed: ["list_channels"] });
  });

  it("falls back to Gemini when NVIDIA returns 503", async () => {
    mockNvidiaResponse(503, "Service Unavailable");
    (dual.runGeminiChat as any).mockResolvedValue({
      text: "fallback worked",
      toolsUsed: false,
      history: [],
    });

    const result = await nvidia.runGeminiChat({
      geminiClient: null,
      systemInstruction: "you are a test bot",
      history: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [],
      message: { userMessage: "hi" },
      isAdmin: false,
      useFastModel: true,
    });

    expect(dual.runGeminiChat).toHaveBeenCalledOnce();
    expect(result.text).toBe("fallback worked");
  });

  it("returns the user-friendly error when both NVIDIA and Gemini fail", async () => {
    mockNvidiaResponse(503, "Service Unavailable");
    (dual.runGeminiChat as any).mockRejectedValue(new Error("Gemini also down"));

    const result = await nvidia.runGeminiChat({
      geminiClient: null,
      systemInstruction: "you are a test bot",
      history: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [],
      message: { userMessage: "hi" },
      isAdmin: false,
      useFastModel: true,
    });

    expect(dual.runGeminiChat).toHaveBeenCalledOnce();
    expect(result.text).toContain("having trouble thinking");
  });

  it("does NOT fall back on 401 auth errors", async () => {
    mockNvidiaResponse(401, "Unauthorized");

    const result = await nvidia.runGeminiChat({
      geminiClient: null,
      systemInstruction: "you are a test bot",
      history: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [],
      message: { userMessage: "hi" },
      isAdmin: false,
      useFastModel: true,
    });

    expect(dual.runGeminiChat).not.toHaveBeenCalled();
    expect(result.text).toContain("having trouble thinking");
  });

  it("does NOT fall back when GEMINI_API_KEY is empty", async () => {
    const savedKeys = config.geminiKeys;
    (config as any).geminiKeys = [];
    mockNvidiaResponse(503, "Service Unavailable");

    const result = await nvidia.runGeminiChat({
      geminiClient: null,
      systemInstruction: "you are a test bot",
      history: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [],
      message: { userMessage: "hi" },
      isAdmin: false,
      useFastModel: true,
    });

    expect(dual.runGeminiChat).not.toHaveBeenCalled();
    expect(result.text).toContain("having trouble thinking");
    (config as any).geminiKeys = savedKeys;
  });

  it("fires the rate-limit callback and opens after three main chat failures", async () => {
    const onLimit = vi.fn();
    const onSuccess = vi.fn();
    nvidia.setRateLimitCallbacks(onLimit, onSuccess);
    mockNvidiaResponse(503, "Service Unavailable");

    await runBasicNvidiaChat();
    await runBasicNvidiaChat();
    expect(nvidia.isRateLimited()).toBe(false);

    await runBasicNvidiaChat();

    expect(onLimit).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(nvidia.isRateLimited()).toBe(true);
  });

  it("half-opens after the circuit cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
    mockNvidiaResponse(503, "Service Unavailable");

    await runBasicNvidiaChat();
    await runBasicNvidiaChat();
    await runBasicNvidiaChat();

    expect(nvidia.isRateLimited()).toBe(true);

    vi.advanceTimersByTime(30_001);

    expect(nvidia.isRateLimited()).toBe(false);
  });

  it("fires the recovery callback on success after the circuit was open", async () => {
    const onLimit = vi.fn();
    const onSuccess = vi.fn();
    nvidia.setRateLimitCallbacks(onLimit, onSuccess);
    mockNvidiaResponse(503, "Service Unavailable");

    await runBasicNvidiaChat();
    await runBasicNvidiaChat();
    await runBasicNvidiaChat();
    expect(nvidia.isRateLimited()).toBe(true);

    mockNvidiaResponse(200, successBody("recovered"));
    const result = await runBasicNvidiaChat();

    expect(result.text).toBe("recovered");
    expect(onLimit).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(nvidia.isRateLimited()).toBe(false);
  });
});
