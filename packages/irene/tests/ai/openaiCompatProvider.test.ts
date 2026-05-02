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

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    const promptText = body.messages.map((m: any) => m.content).filter(Boolean).join("\n");
    expect(promptText).toContain("[tool result: send_gif]");
    expect(promptText).toContain("how about hit the quan for me");
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
