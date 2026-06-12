import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ai/executor.js", () => ({
  executeTool: vi.fn(async () => "stubbed"),
  // Destructive-action confirm render bridge openaiCompat.js now calls on every
  // tool result — passthrough so string results flow through unchanged.
  postDeferralIfNeeded: vi.fn(async (result: unknown) => result),
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
    extraBody: null,
    toolCoaching: false,
    compactSchemas: false,
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

  it("routes catalog-only tools through use_tool", async () => {
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "use_tool",
            arguments: JSON.stringify({ tool_name: "list_channels", arguments: { include_hidden: false } }),
          },
        }],
      }),
      chatMessage({ role: "assistant", content: "listed them" }),
    );
    const executor = vi.fn(async () => "channel list");

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "show channels" },
      executor,
      isAdmin: true,
      routerToolNames: ["list_channels"],
    });
    const firstBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);

    expect(firstBody.tools.map((t: any) => t.function.name)).toContain("use_tool");
    expect(executor).toHaveBeenCalledWith("list_channels", { include_hidden: false });
    expect(result).toEqual({ text: "listed them", toolsUsed: ["list_channels"] });
  });

  it("executes a tier-1 tool even when the model calls it through use_tool", async () => {
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "use_tool",
            arguments: JSON.stringify({ tool_name: "calculate", arguments: { expression: "2+2" } }),
          },
        }],
      }),
      chatMessage({ role: "assistant", content: "calculated" }),
    );
    const executor = vi.fn(async () => "4");

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [{ name: "calculate", description: "Calculate math.", input_schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }],
      message: { userMessage: "2+2" },
      executor,
      routerToolNames: ["list_channels"],
    });

    expect(executor).toHaveBeenCalledWith("calculate", { expression: "2+2" });
    expect(result).toEqual({ text: "calculated", toolsUsed: ["calculate"] });
  });

  it("returns a compact signature for use_tool help without executing", async () => {
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "use_tool",
            arguments: JSON.stringify({ tool_name: "list_channels", help: true }),
          },
        }],
      }),
      chatMessage({ role: "assistant", content: "ok" }),
    );
    const executor = vi.fn(async () => "should not run");

    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "help" },
      executor,
      isAdmin: true,
      routerToolNames: ["list_channels"],
    });
    const secondBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);
    const toolMessage = secondBody.messages.find((m: any) => m.role === "tool");

    expect(executor).not.toHaveBeenCalled();
    expect(toolMessage.content).toContain("list_channels(");
  });

  it("echoes a compact signature when use_tool names a registered tool not offered this turn", async () => {
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "use_tool",
            arguments: JSON.stringify({ tool_name: "list_channels", arguments: {} }),
          },
        }],
      }),
      chatMessage({ role: "assistant", content: "retrying" }),
    );
    const executor = vi.fn(async () => "should not run");

    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "channels" },
      executor,
    });
    const secondBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);
    const toolMessage = secondBody.messages.find((m: any) => m.role === "tool");

    expect(executor).not.toHaveBeenCalled();
    expect(toolMessage.content).toContain(`"list_channels" wasn't offered this turn`);
    expect(toolMessage.content).toContain("Signature:");
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

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [
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
      message: { userMessage: "make a meme" },
      executor: vi.fn(),
      useFastModel: false,
    });

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
    const userText = "[testuser said]\ncount this sentinel once";
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
    const history: any[] = [{ role: "user", content: "[testuser said]\nAlright Irene, dab for me" }];
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
      message: { userMessage: "[testuser said]\nAlright Irene, dab for me" },
      executor,
    });

    expect(first).toEqual({ text: "", toolsUsed: ["send_gif"] });
    expect(history[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_use", name: "send_gif", input: { query: "dab meme", caption: "" } }),
    ]));
    expect(history[2].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", tool_use_id: "call_dab", tool_name: "send_gif" }),
    ]));

    history.push({ role: "user", content: "[testuser said]\nhow about hit the quan for me" });
    mockFetchResponses(chatMessage({ role: "assistant", content: "fresh turn" }));

    await provider.runGeminiChat({
      systemInstruction: "system",
      history,
      tools: [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      message: { userMessage: "[testuser said]\nhow about hit the quan for me" },
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

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [{ name: "web_search", description: "search web", input_schema: { type: "object" } }],
      message: { userMessage: "who is jtmachina" },
      executor,
    });
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

  it("leaves hosted-default schema text byte-identical and compacts when enabled", async () => {
    const fatTool = {
      name: "setup_ticket",
      description: "Set up a long ticket workflow for staff triage. This second sentence carries detailed operational guidance that local models do not need in the wire schema.",
      input_schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["simple", "advanced"],
            description: "Choose whether the ticket workflow should use the simple preset or the advanced preset with custom panels, transcripts, and staff routing.",
          },
        },
        required: ["mode"],
      },
    };

    Object.assign(config.openaiCompat, { compactSchemas: false });
    mockFetchResponses(chatMessage({ role: "assistant", content: "ok" }));
    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [JSON.parse(JSON.stringify(fatTool))],
      message: { userMessage: "tickets" },
      executor: vi.fn(),
    });
    const fullBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    const fullTool = fullBody.tools[0].function;

    Object.assign(config.openaiCompat, { compactSchemas: true });
    mockFetchResponses(chatMessage({ role: "assistant", content: "ok" }));
    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [JSON.parse(JSON.stringify(fatTool))],
      message: { userMessage: "tickets" },
      executor: vi.fn(),
    });
    const compactBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    const compactTool = compactBody.tools[0].function;

    expect(fullTool.description).toBe(fatTool.description);
    expect(fullTool.parameters.properties.mode.description).toBe(fatTool.input_schema.properties.mode.description);
    expect(compactTool.description).toBe("Set up a long ticket workflow for staff triage.");
    expect(compactTool.parameters.properties.mode.description.length).toBeLessThanOrEqual(80);
    expect(compactTool.parameters.properties.mode.description).not.toContain("transcripts");
    expect(compactTool.name).toBe("setup_ticket");
    expect(compactTool.parameters.properties.mode.enum).toEqual(["simple", "advanced"]);
    expect(compactTool.parameters.required).toEqual(["mode"]);
    expect(JSON.stringify(compactBody.tools).length).toBeLessThan(JSON.stringify(fullBody.tools).length);
  });

  it("strips <think> reasoning blocks from the reply text and history", async () => {
    mockFetchResponses(chatMessage({
      role: "assistant",
      content: "<think>the user greeted me.\nplan a greeting.</think>hey, what's up",
    }));
    const history: any[] = [];

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history,
      tools: [],
      message: { userMessage: "hi" },
      executor: vi.fn(),
      useFastModel: true,
    });

    expect(result).toEqual({ text: "hey, what's up", toolsUsed: [] });
    expect(history.at(-1)).toEqual({ role: "assistant", content: "hey, what's up" });
  });

  it("strips an unclosed <think> block from a truncated reply", async () => {
    mockFetchResponses({
      choices: [{
        message: { role: "assistant", content: "<think>all reasoning, cut off by max_tok" },
        finish_reason: "length",
      }],
    });

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "hi" },
      executor: vi.fn(),
    });

    // Think-only truncated response collapses to "" → finish_reason fallback.
    expect(result).toEqual({ text: "i got cut off thinking there, try again in a sec", toolsUsed: [] });
  });

  it("strips reasoning BEFORE the hallucinated-call rescue parse", async () => {
    const executor = vi.fn(async () => "search result");
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: '<think>i should search</think>{"tool":"web_search","arguments":{"query":"cats"}}',
      }),
      chatMessage({ role: "assistant", content: "found cats" }),
    );

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [{ name: "web_search", description: "search web", input_schema: { type: "object" } }],
      message: { userMessage: "search cats" },
      executor,
    });

    expect(executor).toHaveBeenCalledWith("web_search", { query: "cats" });
    expect(result).toEqual({ text: "found cats", toolsUsed: ["web_search"] });
  });

  it("rescues hallucinated JSON calls through aliases for router-only tools", async () => {
    const executor = vi.fn(async () => "channel list");
    mockFetchResponses(
      chatMessage({
        role: "assistant",
        content: '{"tool":"channels","arguments":{"include_hidden":false}}',
      }),
      chatMessage({ role: "assistant", content: "listed channels" }),
    );

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "show channels" },
      executor,
      isAdmin: true,
      routerToolNames: ["list_channels"],
    });

    expect(executor).toHaveBeenCalledWith("list_channels", { include_hidden: false });
    expect(result).toEqual({ text: "listed channels", toolsUsed: ["list_channels"] });
  });

  it("does not rescue content-JSON that names an unknown tool", async () => {
    const executor = vi.fn(async () => "should not run");
    const garbage = '{"tool":"totally_fake_tool","arguments":{"query":"channels"}}';
    mockFetchResponses(chatMessage({ role: "assistant", content: garbage }));

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [{ name: "web_search", description: "search web", input_schema: { type: "object" } }],
      message: { userMessage: "run fake tool" },
      executor,
      isAdmin: true,
      routerToolNames: ["list_channels"],
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result).toEqual({ text: garbage, toolsUsed: [] });
  });

  it("discards reasoning_content / reasoning fields instead of concatenating them", async () => {
    mockFetchResponses(chatMessage({
      role: "assistant",
      content: "the answer",
      reasoning_content: "secret chain of thought",
      reasoning: "more secret thought",
    }));

    const result = await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [],
      message: { userMessage: "hi" },
      executor: vi.fn(),
    });

    expect(result.text).toBe("the answer");
    expect(result.text).not.toContain("secret");
  });

  it("strips <think> from quickReply text", async () => {
    mockFetchResponses(chatMessage({ role: "assistant", content: "<think>plan ack</think>on it" }));

    await expect(provider.quickReply(null, "system", "do the thing", null)).resolves.toBe("on it");
  });

  it("merges extraBody into the request body without overriding messages/tools/model", async () => {
    Object.assign(config.openaiCompat, {
      extraBody: {
        options: { num_ctx: 32768 },
        think: false,
        model: "evil-model",
        messages: [],
        tools: [{ fake: true }],
      },
    });
    mockFetchResponses(chatMessage({ role: "assistant", content: "ok" }));

    await provider.runGeminiChat({
      systemInstruction: "system",
      history: [],
      tools: [{ name: "search", description: "search", input_schema: { type: "object" } }],
      message: { userMessage: "hi" },
      executor: vi.fn(),
    });

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.options).toEqual({ num_ctx: 32768 });
    expect(body.think).toBe(false);
    expect(body.model).toBe("test-model");
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.tools[0].function.name).toBe("search");
  });

  it("appends the tool coaching block to the system prompt when enabled and tools are present", async () => {
    Object.assign(config.openaiCompat, { toolCoaching: true });
    mockFetchResponses(chatMessage({ role: "assistant", content: "ok" }));

    await provider.runGeminiChat({
      systemInstruction: "personality prompt",
      history: [],
      tools: [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      message: { userMessage: "dab" },
      executor: vi.fn(),
    });

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("personality prompt");
    expect(body.messages[0].content).toContain("[TOOL USE — CRITICAL]");
  });

  it("does not append the coaching block by default", async () => {
    mockFetchResponses(chatMessage({ role: "assistant", content: "ok" }));

    await provider.runGeminiChat({
      systemInstruction: "personality prompt",
      history: [],
      tools: [{ name: "send_gif", description: "send gif", input_schema: { type: "object" } }],
      message: { userMessage: "dab" },
      executor: vi.fn(),
    });

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].content).toBe("personality prompt");
  });
});
