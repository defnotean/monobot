import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ai/executor.js", () => ({
  executeTool: vi.fn(async () => "stubbed"),
}));

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
    apiKeys: ["test-key"],
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

describe("OpenAI-compatible provider (Irene)", () => {
  it("returns a text response from Irene object-call style", async () => {
    mockFetchResponses(chatMessage({ role: "assistant", content: "hello there" }));
    const history: any[] = [];

    const result = await provider.runGeminiChat({
      geminiClient: null,
      systemInstruction: "system",
      history,
      tools: [],
      message: { userMessage: "hi" },
      isAdmin: false,
      useFastModel: true,
    });

    expect(result).toEqual({ text: "hello there", toolsUsed: [] });
    expect(history.at(-1)).toEqual({ role: "assistant", content: "hello there" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://compat.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rotates to the next configured key when OpenRouter rate-limits one", async () => {
    Object.assign(config.openaiCompat, {
      apiKey: "test-key-1",
      apiKeys: ["test-key-1", "test-key-2"],
    });
    let index = 0;
    globalThis.fetch = vi.fn(async () => {
      index += 1;
      if (index === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => "rate limited",
          json: async () => ({}),
        };
      }
      const body = chatMessage({ role: "assistant", content: "rotated-ok" });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    }) as any;

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "hi" },
      executor: vi.fn(),
    });

    expect(result).toEqual({ text: "rotated-ok", toolsUsed: [] });
    expect((globalThis.fetch as any).mock.calls[0][1].headers.Authorization).toBe("Bearer test-key-1");
    expect((globalThis.fetch as any).mock.calls[1][1].headers.Authorization).toBe("Bearer test-key-2");
  });

  it("rotates keys across successful requests for quota smoothing", async () => {
    Object.assign(config.openaiCompat, {
      apiKey: "test-key-1",
      apiKeys: ["test-key-1", "test-key-2"],
    });
    mockFetchResponses(
      chatMessage({ role: "assistant", content: "first-ok" }),
      chatMessage({ role: "assistant", content: "second-ok" }),
    );

    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "first" },
      executor: vi.fn(),
    });
    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "second" },
      executor: vi.fn(),
    });

    const usedKeys = (globalThis.fetch as any).mock.calls.map((call: any[]) => call[1].headers.Authorization);
    expect(new Set(usedKeys)).toEqual(new Set(["Bearer test-key-1", "Bearer test-key-2"]));
  });

  it("does not duplicate the current user message when history already contains it", async () => {
    const userText = "[defnotean said]\ncount this sentinel once";
    const history: any[] = [{ role: "user", content: userText }];
    mockFetchResponses(chatMessage({ role: "assistant", content: "normal-ok" }));

    await provider.runGeminiChat({
      systemInstruction: "system",
      history,
      tools: [],
      message: { userMessage: userText },
      executor: vi.fn(),
    });

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).not.toHaveProperty("tools");
    expect(body.messages.filter((m: any) => m.role === "user" && m.content === userText)).toHaveLength(1);
  });

  it("executes tool calls and returns final text", async () => {
    const executor = vi.fn(async (_name, args) => ({ ok: true, value: args.query }));
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: JSON.stringify({ query: "irene" }) },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "found it" }),
    );

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [{ name: "search", description: "search stuff", input_schema: { type: "object" } }],
      message: { userMessage: "search irene" },
      executor,
      useFastModel: false,
    });

    expect(executor).toHaveBeenCalledWith("search", { query: "irene" });
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

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "search" },
      executor,
    });
    const secondBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);

    expect(executor).not.toHaveBeenCalled();
    expect(secondBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_bad",
    });
    expect(secondBody.messages.at(-1).content).toContain("malformed JSON");
    expect(result).toEqual({ text: "args were bad", toolsUsed: [] });
  });

  it("persists tool calls and results so later turns do not replay old actions", async () => {
    const history: any[] = [{ role: "user", content: "[defnotean said]\nAlright Irene, dab for me" }];
    const executor = vi.fn(async (_name, args) => ({ ok: true, sent: args.query }));

    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_dab",
            type: "function",
            function: { name: "send_gif", arguments: JSON.stringify({ query: "dab meme", caption: "" }) },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "" }),
    );

    const first = await provider.runGeminiChat({
      systemInstruction: "system",
      history,
      tools: [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      message: { userMessage: "[defnotean said]\nAlright Irene, dab for me" },
      executor,
    });

    expect(first).toEqual({ text: "", toolsUsed: ["send_gif"] });
    expect(history[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_use", name: "send_gif", input: { query: "dab meme", caption: "" } }),
    ]));
    expect(history[2].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", tool_use_id: "call_dab", tool_name: "send_gif" }),
    ]));

    history.push({ role: "user", content: "[defnotean said]\nhow about hit the quan for me" });
    mockFetchResponses(chatMessage({ role: "assistant", content: "fresh turn" }));

    await provider.runGeminiChat({
      systemInstruction: "system",
      history,
      tools: [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      message: { userMessage: "[defnotean said]\nhow about hit the quan for me" },
      executor,
    });

    // The next request body should reconstruct proper OpenAI-shape tool_calls
    // from the Anthropic blocks, NOT stringify them as `[tool call: ...]` prose.
    // The prose form taught the model to emit text-shaped tool calls in fresh
    // content while leaving the real tool_calls field empty.
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    const assistantWithToolCalls = body.messages.find(
      (m: any) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(assistantWithToolCalls).toBeTruthy();
    expect(assistantWithToolCalls.tool_calls[0].id).toBe("call_dab");
    expect(assistantWithToolCalls.tool_calls[0].function.name).toBe("send_gif");

    const toolResultMsg = body.messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_dab",
    );
    expect(toolResultMsg).toBeTruthy();

    const userTurn = body.messages.find(
      (m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("hit the quan"),
    );
    expect(userTurn).toBeTruthy();
  });

  it("guards duplicate tool calls and returns a visible fallback", async () => {
    const executor = vi.fn(async () => "first result");
    const duplicateCall = {
      type: "function",
      function: { name: "search", arguments: JSON.stringify({ query: "repeat" }) },
    };
    mockFetchResponses(
      chatMessage({ role: "assistant", content: null, tool_calls: [{ ...duplicateCall, id: "call_1" }] }),
      chatMessage({ role: "assistant", content: null, tool_calls: [{ ...duplicateCall, id: "call_2" }] }),
    );

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "search" },
      executor,
    });
    const secondBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);

    expect(executor).toHaveBeenCalledOnce();
    expect(secondBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "first result",
    });
    expect(result).toEqual({
      text: "i already checked that, but got stuck finishing the answer. try again in a sec",
      toolsUsed: ["search"],
    });
  });

  it("does not open the main chat circuit when quick replies time out", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    }) as any;

    await expect(provider.quickReply(null, "system", "ping", null)).resolves.toBeNull();
    await expect(provider.quickReply(null, "system", "ping", null)).resolves.toBeNull();
    await expect(provider.quickReply(null, "system", "ping", null)).resolves.toBeNull();

    expect(provider.isRateLimited()).toBe(false);
  });

  it("converts Anthropic, Gemini, and OpenAI tool schemas", () => {
    const anthropic = provider.toGeminiTools([
      {
        name: "remember",
        description: "save",
        input_schema: {
          type: ["object", "null"],
          properties: {
            text: { type: "string", enum: [1, true, "saved"], anyOf: [{ type: "string" }] },
          },
          additionalProperties: false,
          $schema: "draft",
        },
      },
    ]);
    const gemini = provider.toGeminiTools([
      { functionDeclarations: [{ name: "search", description: "find", parameters: { type: "object" } }] },
    ]);
    const openai = provider.toGeminiTools([
      { type: "function", function: { name: "ping", description: "pong", parameters: { type: "object" } } },
    ]);

    expect(anthropic?.[0]).toMatchObject({
      type: "function",
      function: { name: "remember", parameters: { type: "object" } },
    });
    expect(anthropic?.[0].function.parameters).not.toHaveProperty("$schema");
    expect(anthropic?.[0].function.parameters).not.toHaveProperty("additionalProperties");
    expect(anthropic?.[0].function.parameters.properties.text).not.toHaveProperty("anyOf");
    expect(anthropic?.[0].function.parameters.properties.text.enum).toEqual(["1", "true", "saved"]);
    expect(gemini?.[0].function.name).toBe("search");
    expect(openai?.[0].function.name).toBe("ping");
  });
});
