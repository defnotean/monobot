import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatProvider, classifyProviderError } from "../../src/ai/openaiCompat.js";

const realFetch = globalThis.fetch;

function chatMessage(message: any) {
  return {
    choices: [
      {
        message,
        finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
  };
}

function mockFetchResponses(...responses: any[]) {
  let index = 0;
  globalThis.fetch = vi.fn(async () => {
    const body = responses[index++] ?? responses[responses.length - 1];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as any;
}

function baseConfig(overrides: Record<string, any> = {}) {
  return {
    timeouts: { worker: 20_000, workerSlow: 30_000, toolSlow: 10_000, quickReply: 5_000 },
    openaiCompat: {
      apiKey: "test-key",
      apiKeys: ["test-key"],
      baseUrl: "https://compat.test/v1",
      model: "chat-model",
      fastModel: "fast-model",
      maxTokens: 256,
      temperature: 0.1,
      topP: 0.9,
      providerName: "Shared Compat",
      extraHeaders: {},
      toolChoice: "auto",
      extraBody: null,
      toolCoaching: false,
      compactSchemas: false,
      maxIterations: 4,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("shared OpenAI-compatible provider factory", () => {
  it("runs object-style chats through injected router, executor, deferral, status, and history flavor deps", async () => {
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "use_tool",
            arguments: JSON.stringify({ tool_name: "alias_tool", arguments: { query: "shared" } }),
          },
        }],
      }),
      chatMessage({ role: "assistant", content: "done" }),
    );

    const log = vi.fn();
    const defaultExecutor = vi.fn(async () => "raw result");
    const postProcessToolResult = vi.fn(async (value: unknown) => `posted:${value}`);
    const onToolStatus = vi.fn(async () => {});
    const history: any[] = [];
    const provider = createOpenAICompatProvider({
      getConfig: () => baseConfig(),
      log,
      resolveAlias: (name: string) => name === "alias_tool" ? "canonical_tool" : name,
      getDeclaration: (name: string) => name === "canonical_tool"
        ? { name, description: "Canonical tool.", input_schema: { type: "object", properties: { query: { type: "string" } } } }
        : null,
      taskKeywordPattern: /shared-task/i,
      historyFlavor: "anthropic",
      defaultExecutor,
      postProcessToolResult,
      botLabel: "Shared",
    });

    expect(provider.looksLikeTask("this is a shared-task")).toBe(true);

    const result = await provider.runOpenAICompatChat({
      systemInstruction: "system",
      history,
      tools: [],
      message: { userMessage: "run it", channel: { send: vi.fn() } },
      routerToolNames: ["canonical_tool"],
      onToolStatus,
    });

    expect(defaultExecutor).toHaveBeenCalledWith("canonical_tool", { query: "shared" }, expect.objectContaining({ userMessage: "run it" }));
    expect(postProcessToolResult).toHaveBeenCalledWith("raw result", expect.anything());
    expect(onToolStatus).toHaveBeenCalledWith("running canonical_tool");
    expect(result).toEqual({ text: "done", toolsUsed: ["canonical_tool"] });
    expect(history[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_use", id: "call_1", name: "canonical_tool" }),
    ]));
    expect(history.at(-1)).toEqual({ role: "assistant", content: "done" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("canonical_tool"));
  });

  it("can auto-send quick replies when configured", async () => {
    mockFetchResponses(chatMessage({ role: "assistant", content: "<think>plan</think>quick text" }));
    const reply = vi.fn(async () => {});
    const provider = createOpenAICompatProvider({
      getConfig: () => baseConfig(),
      log: vi.fn(),
      quickReplyAutoSend: true,
      botLabel: "Shared",
    });

    await expect(provider.quickReply(null, "system", "ping", { reply })).resolves.toBe("quick text");

    expect(reply).toHaveBeenCalledWith("quick text");
  });

  it("keeps the richer provider error classifier shape", () => {
    expect(classifyProviderError({ status: 401 })).toEqual({ shouldFallback: false, label: "auth-401" });
    expect(classifyProviderError({ status: 503 })).toEqual({ shouldFallback: true, label: "server-503" });
    expect(classifyProviderError(new Error("timeout while waiting"))).toEqual({ shouldFallback: true, label: "timeout" });
  });
});
