import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// @ts-expect-error JS module without types
import * as provider from "../../ai/providers/openaiCompat.js";
// @ts-expect-error JS module without types
import config from "../../config.js";

const realFetch = globalThis.fetch;
const savedConfig = { ...config.openaiCompat };

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

beforeEach(() => {
  Object.assign(config.openaiCompat, {
    apiKey: "test-key",
    baseUrl: "https://compat.test/v1",
    model: "test-model",
    fastModel: "test-fast-model",
    maxTokens: 512,
    temperature: 0.2,
    topP: 0.9,
    providerName: "Test Compat",
    extraHeaders: {},
    toolChoice: "auto",
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(config.openaiCompat, savedConfig);
  vi.restoreAllMocks();
});

describe("OpenAI-compatible provider (Eris)", () => {
  it("returns a text response", async () => {
    mockFetchResponses(chatMessage({ role: "assistant", content: "hello there" }));

    const result = await provider.runGeminiChat(null, "system", [], [], "hi", vi.fn());

    expect(result).toEqual({ text: "hello there", toolsUsed: [] });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://compat.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("executes tool calls and returns the final text", async () => {
    const executor = vi.fn(async (_name, args) => ({ ok: true, value: args.query }));
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: JSON.stringify({ query: "eris" }) },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "found it" }),
    );

    const result = await provider.runGeminiChat(
      null,
      "system",
      [{ name: "search", description: "search stuff", input_schema: { type: "object" } }],
      [],
      "search eris",
      executor,
    );

    expect(executor).toHaveBeenCalledWith("search", { query: "eris" });
    expect(result).toEqual({ text: "found it", toolsUsed: ["search"] });
  });

  it("reports malformed tool arguments without executing the tool", async () => {
    const executor = vi.fn();
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "search", arguments: "{not json" },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "args were bad" }),
    );

    const result = await provider.runGeminiChat(null, "system", [], [], "search", executor);
    const secondBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);

    expect(executor).not.toHaveBeenCalled();
    expect(secondBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_bad",
    });
    expect(secondBody.messages.at(-1).content).toContain("malformed JSON");
    expect(result).toEqual({ text: "args were bad", toolsUsed: [] });
  });

  it("guards duplicate tool calls", async () => {
    const executor = vi.fn(async () => "first result");
    const duplicateCall = {
      type: "function",
      function: { name: "search", arguments: JSON.stringify({ query: "repeat" }) },
    };
    mockFetchResponses(
      chatMessage({ role: "assistant", content: null, tool_calls: [{ ...duplicateCall, id: "call_1" }] }),
      chatMessage({ role: "assistant", content: null, tool_calls: [{ ...duplicateCall, id: "call_2" }] }),
    );

    const result = await provider.runGeminiChat(null, "system", [], [], "search", executor);
    const secondBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);

    expect(executor).toHaveBeenCalledOnce();
    expect(secondBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "first result",
    });
    expect(result).toEqual({ text: "", toolsUsed: ["search"] });
  });

  it("converts Anthropic, Gemini, and OpenAI tool schemas", () => {
    const anthropic = provider.toGeminiTools([
      {
        name: "remember",
        description: "save",
        input_schema: { type: ["object", "null"], properties: { text: { type: "string" } }, $schema: "draft" },
      },
    ]);
    const gemini = provider.toGeminiTools([
      {
        functionDeclarations: [
          { name: "search", description: "find", parameters: { type: "object", properties: {} } },
        ],
      },
    ]);
    const openai = provider.toGeminiTools([
      {
        type: "function",
        function: { name: "ping", description: "pong", parameters: { type: "object" } },
      },
    ]);

    expect(anthropic?.[0]).toMatchObject({
      type: "function",
      function: { name: "remember", parameters: { type: "object" } },
    });
    expect(anthropic?.[0].function.parameters).not.toHaveProperty("$schema");
    expect(gemini?.[0].function.name).toBe("search");
    expect(openai?.[0].function.name).toBe("ping");
  });
});
