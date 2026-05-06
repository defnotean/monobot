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

  it("sends Owl Alpha tools without unsupported tool_choice", async () => {
    Object.assign(config.openaiCompat, {
      model: "openrouter/owl-alpha",
      fastModel: "openrouter/owl-alpha",
      maxTokens: 8192,
      temperature: 0.9,
      topP: 1,
      toolChoice: "none",
    });
    mockFetchResponses(chatMessage({ role: "assistant", content: "ready" }));

    const result = await provider.runGeminiChat(
      null,
      "system",
      [
        {
          name: "search_meme_templates",
          description: "search meme templates",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      [],
      "make a meme",
      vi.fn(),
    );

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: "openrouter/owl-alpha",
      max_tokens: 8192,
      temperature: 0.9,
      top_p: 1,
    });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "search_meme_templates" },
    });
    expect(body).not.toHaveProperty("tool_choice");
    expect(result).toEqual({ text: "ready", toolsUsed: [] });
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

    const result = await provider.runGeminiChat(null, "system", [], [], "hi", vi.fn());

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

    await provider.runGeminiChat(null, "system", [], [], "first", vi.fn());
    await provider.runGeminiChat(null, "system", [], [], "second", vi.fn());

    const usedKeys = (globalThis.fetch as any).mock.calls.map((call: any[]) => call[1].headers.Authorization);
    expect(new Set(usedKeys)).toEqual(new Set(["Bearer test-key-1", "Bearer test-key-2"]));
  });

  it("does not duplicate the current user message when history already contains it", async () => {
    const userText = "[defnotean said]\ncount this sentinel once";
    const history: any[] = [{ role: "user", parts: [{ text: userText }] }];
    mockFetchResponses(chatMessage({ role: "assistant", content: "normal-ok" }));

    await provider.runGeminiChat(null, "system", [], history, userText, vi.fn());

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).not.toHaveProperty("tools");
    expect(body.messages.filter((m: any) => m.role === "user" && m.content === userText)).toHaveLength(1);
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
    expect(result).toEqual({
      text: "i already checked that, but got stuck finishing the answer. try again in a sec",
      toolsUsed: ["search"],
    });
  });

  it("reuses same-turn web search results for near-duplicate queries", async () => {
    const executor = vi.fn(async () => "no useful results found");
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ query: "jtmachina" }) },
        }],
      }),
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_2",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ query: "jtmachina creator" }) },
        }],
      }),
      chatMessage({ role: "assistant", content: "i still could not find much on that name" }),
    );

    const result = await provider.runGeminiChat(
      null,
      "system",
      [{ name: "web_search", description: "search web", input_schema: { type: "object" } }],
      [],
      "who is jtmachina",
      executor,
    );
    const thirdBody = JSON.parse((globalThis.fetch as any).mock.calls[2][1].body);

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith("web_search", { query: "jtmachina" });
    expect(thirdBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_2",
    });
    expect(thirdBody.messages.at(-1).content).toContain('Already searched for "jtmachina creator"');
    expect(thirdBody.messages.at(-1).content).toContain("no useful results found");
    expect(result).toEqual({ text: "i still could not find much on that name", toolsUsed: ["web_search"] });
  });

  it("persists tool calls as structured Gemini parts so later turns replay as proper OpenAI tool_calls (not prose)", async () => {
    const history: any[] = [{ role: "user", parts: [{ text: "[defnotean said]\nAlright Eris, dab for me" }] }];
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

    const first = await provider.runGeminiChat(
      null,
      "system",
      [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      history,
      "[defnotean said]\nAlright Eris, dab for me",
      executor,
    );

    expect(first).toEqual({ text: "", toolsUsed: ["send_gif"] });

    // Assistant turn must carry a structured functionCall part — NOT a text-only
    // `[tool call: ...]` prose serialization. The prose form taught the model
    // to imitate it as text content while leaving the real tool_calls field empty.
    const assistantTurn = history[1];
    expect(assistantTurn.role).toBe("model");
    const callPart = assistantTurn.parts.find((p: any) => p.functionCall);
    expect(callPart?.functionCall?.name).toBe("send_gif");
    expect(callPart?.functionCall?.args).toEqual({ query: "dab meme", caption: "" });
    expect(callPart?.functionCall?._id).toBe("call_dab");

    // Tool-result turn carries a structured functionResponse part with the
    // matching _id so the next-turn converter can pair it with the assistant call.
    const resultTurn = history[2];
    expect(resultTurn.role).toBe("user");
    const resultPart = resultTurn.parts.find((p: any) => p.functionResponse);
    expect(resultPart?.functionResponse?.name).toBe("send_gif");
    expect(resultPart?.functionResponse?._id).toBe("call_dab");

    history.push({ role: "user", parts: [{ text: "[defnotean said]\nhow about hit the quan for me" }] });
    mockFetchResponses(chatMessage({ role: "assistant", content: "fresh turn" }));

    await provider.runGeminiChat(
      null,
      "system",
      [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      history,
      "[defnotean said]\nhow about hit the quan for me",
      executor,
    );

    // The next request body should contain a real assistant.tool_calls field
    // referencing the previous call, plus a role:"tool" message with the
    // matching tool_call_id — NOT a stringified `[tool call: ...]` prose blob.
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
            text: { type: "string", enum: [1, true, "saved"], oneOf: [{ type: "string" }] },
          },
          additionalProperties: false,
          $schema: "draft",
        },
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
    expect(anthropic?.[0].function.parameters).not.toHaveProperty("additionalProperties");
    expect(anthropic?.[0].function.parameters.properties.text).not.toHaveProperty("oneOf");
    expect(anthropic?.[0].function.parameters.properties.text.enum).toEqual(["1", "true", "saved"]);
    expect(gemini?.[0].function.name).toBe("search");
    expect(openai?.[0].function.name).toBe("ping");
  });
});
