// Outer turn deadline (audit F5): invokeAI races the provider call against
// config.timeouts.turnDeadline so a wedged provider (compat lane: many
// iterations × slow calls) can't hold the per-channel lock forever. On
// deadline the call resolves with the standard error-reply shape instead of
// hanging.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runGeminiChat: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  default: { timeouts: { turnDeadline: 60 } },
}));
vi.mock("../../../database.js", () => ({ logToolUsage: vi.fn() }));
vi.mock("../../../utils/logger.js", () => ({ log: h.log }));
vi.mock("../../../ai/providers/index.js", () => ({
  runGeminiChat: h.runGeminiChat,
  looksLikeTask: vi.fn(() => false),
  quickReply: vi.fn(),
  setRateLimitCallbacks: vi.fn(),
}));
vi.mock("../../../ai/executor.js", () => ({ executeTool: vi.fn() }));
vi.mock("../../../events/messageCreate/geminiPool.js", () => ({
  activeProviderNeedsGeminiClient: vi.fn(() => false),
  activeProviderLabel: vi.fn(() => "Test Compat"),
  getConvClient: vi.fn(() => null),
  getWorkClient: vi.fn(() => null),
  _geminiPools: {},
}));

// @ts-expect-error JS module without types
import { invokeAI } from "../../../events/messageCreate/aiInvoke.js";

function fakeMessage() {
  return {
    author: { id: "user-1", username: "tester" },
    channel: { id: "chan-1" },
    reply: vi.fn(async () => {}),
  } as any;
}

function invokeArgs() {
  return {
    message: fakeMessage(),
    cleanMessage: "hello",
    systemInstruction: "sys",
    formattedTools: [],
    routerToolNames: [],
    history: [],
    userMsg: "hello",
    isTwinMsg: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invokeAI turn deadline", () => {
  it("returns the timeout reply shape when the provider exceeds the deadline", async () => {
    // Provider never settles within the 60ms test deadline.
    h.runGeminiChat.mockImplementation(() => new Promise(() => {}));

    const { result, skipped } = await invokeAI(invokeArgs());

    expect(skipped).toBeUndefined();
    expect(result).toEqual({ text: "that took too long, try again in a sec", toolsUsed: [] });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("deadline"));
  });

  it("passes a fast provider result through unchanged", async () => {
    h.runGeminiChat.mockResolvedValue({ text: "quick answer", toolsUsed: ["search"] });

    const { result } = await invokeAI(invokeArgs());

    expect(result).toEqual({ text: "quick answer", toolsUsed: ["search"] });
    expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("deadline"));
  });

  it("still propagates provider rejections to the orchestrator's catch", async () => {
    h.runGeminiChat.mockRejectedValue(new Error("provider exploded"));

    await expect(invokeAI(invokeArgs())).rejects.toThrow("provider exploded");
  });
});
