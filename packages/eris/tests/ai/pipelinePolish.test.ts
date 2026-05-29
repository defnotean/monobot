import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Regression tests for the Eris provider-pipeline polish:
//   (a) dual.js honors config.timeouts for the runGeminiChat outer timeout
//   (b) isRateLimited() reflects real work-pool health (all keys rate-limited)
//   (c) nvidia.js dedups identical tool calls via the same stableSig key-sorted
//       signature dual.js uses for Gemini
//
// NOTE: this file must NOT mock ../../ai/dual.js — nvidia.js now imports the
// real stableSig from dual.js, and (a)/(b) exercise dual.js directly.

// @ts-expect-error — JS module without types
import * as dual from "../../ai/dual.js";
// @ts-expect-error — JS module without types
import * as nvidia from "../../ai/providers/nvidia.js";
// @ts-expect-error — JS module without types
import { _geminiPools } from "../../events/messageCreate/geminiPool.js";
// @ts-expect-error — JS module without types
import config from "../../config.js";

// ─── (a) config.timeouts is honored by runGeminiChat ────────────────────────

describe("dual.runGeminiChat honors config.timeouts", () => {
  const savedTimeouts = { ...config.timeouts };

  afterEach(() => {
    Object.assign(config.timeouts, savedTimeouts);
  });

  it("uses config.timeouts.workerSlow for the worker outer timeout and aborts in-flight work", async () => {
    // Custom (small) worker timeout — the rejection message must reflect THIS
    // value, not the hardcoded 90s, proving the config value is read. The worker
    // (non-fast) path reads workerSlow specifically.
    config.timeouts.workerSlow = 1000;

    let capturedSignal: AbortSignal | undefined;
    // A client whose generateContent never resolves on its own — only the
    // outer timeout can end the call, and it must abort the passed signal.
    const client = {
      models: {
        generateContent: vi.fn((req: any) => {
          capturedSignal = req?.config?.abortSignal;
          return new Promise(() => {}); // never resolves
        }),
      },
    };

    const start = Date.now();
    await expect(
      dual.runGeminiChat(
        client,
        "sys",
        [],
        [{ role: "user", parts: [{ text: "hi" }] }],
        "hi",
        vi.fn(async () => "tool result"),
        { useFastModel: false },
      ),
    ).rejects.toThrow(/timed out after 1s/);

    // Honored the configured 1s window (not the 90s default).
    expect(Date.now() - start).toBeLessThan(3000);
    // The outer timeout aborted the in-flight generateContent rather than
    // leaking it: the signal threaded into the SDK call is now aborted.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("reads config.timeouts.workerFast for the fast path (distinct from workerSlow)", async () => {
    // The fast/worker split must be a REAL split: the fast path reads workerFast,
    // the worker path reads workerSlow. Setting only workerFast to a tiny value
    // proves the fast path uses workerFast (not workerSlow, not a shared key).
    config.timeouts.workerFast = 1000;
    config.timeouts.workerSlow = 90_000; // large — must NOT govern the fast path

    const client = {
      models: { generateContent: vi.fn(() => new Promise(() => {})) },
    };

    const start = Date.now();
    await expect(
      dual.runGeminiChat(
        client,
        "sys",
        [],
        [{ role: "user", parts: [{ text: "hi" }] }],
        "hi",
        vi.fn(),
        { useFastModel: true },
      ),
    ).rejects.toThrow(/timed out after 1s/);
    // Used the small workerFast (1s), not the 90s workerSlow.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("falls back to the intended 45s/90s split when both keys are unset", async () => {
    // In production both keys are always defined, but the in-code fallbacks must
    // preserve the documented fast(45s)/worker(90s) split if config is stripped.
    delete (config.timeouts as any).workerFast;
    delete (config.timeouts as any).workerSlow;

    const client = {
      models: { generateContent: vi.fn(() => new Promise(() => {})) },
    };

    // Don't actually wait 45s — race each call against a short probe and assert
    // it has NOT rejected early (proving it used the large default, not a tiny one).
    const probe = () => new Promise((res) => setTimeout(() => res("pending"), 100));
    for (const useFastModel of [true, false]) {
      const call = dual
        .runGeminiChat(client, "sys", [], [{ role: "user", parts: [{ text: "hi" }] }], "hi", vi.fn(), {
          useFastModel,
        })
        .catch((e: Error) => e);
      const winner = await Promise.race([call, probe()]);
      expect(winner).toBe("pending"); // still pending — both defaults are far above 100ms
    }
  });
});

// ─── (b) isRateLimited reflects real work-pool health ───────────────────────

describe("dual.isRateLimited reflects work-pool health", () => {
  beforeEach(() => {
    // Bind the real work pool deterministically (it exists in tests because
    // setup.ts always provides a GEMINI_API_KEY).
    dual.setWorkPool(_geminiPools.work);
  });

  afterEach(() => {
    // Reset every key to available so we don't leak state into other tests.
    const now = Date.now();
    for (const entry of _geminiPools.work.clients) entry.rateLimitedUntil = now - 1000;
  });

  it("returns true when every key in the work pool is rate-limited", () => {
    const future = Date.now() + 60_000;
    for (const entry of _geminiPools.work.clients) entry.rateLimitedUntil = future;
    expect(dual.isRateLimited()).toBe(true);
  });

  it("returns false when at least one key is available", () => {
    const now = Date.now();
    const future = now + 60_000;
    // Limit all but the first key.
    _geminiPools.work.clients.forEach((entry: any, i: number) => {
      entry.rateLimitedUntil = i === 0 ? now - 1000 : future;
    });
    expect(dual.isRateLimited()).toBe(false);
  });

  it("returns false when there is no work pool", () => {
    dual.setWorkPool(null);
    expect(dual.isRateLimited()).toBe(false);
    dual.setWorkPool(_geminiPools.work); // restore for afterEach
  });
});

// ─── (c) nvidia.js dedups identical calls via stableSig ─────────────────────

describe("nvidia.js dedups identical tool calls (stableSig)", () => {
  const realFetch = globalThis.fetch;
  const savedNvidia = { ...config.nvidia };

  beforeEach(() => {
    Object.assign(config.nvidia, {
      apiKey: "test-nvidia-key",
      baseUrl: "https://nv.test/v1",
      model: "test-model",
      fastModel: "test-fast",
      maxTokens: 512,
      temperature: 0.4,
      topP: 0.95,
      thinking: false,
      toolStrictness: "strict",
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(config.nvidia, savedNvidia);
    vi.restoreAllMocks();
  });

  function chatMessage(message: any) {
    return {
      choices: [
        { message, finish_reason: message.tool_calls?.length ? "tool_calls" : "stop" },
      ],
    };
  }

  it("collapses the same tool call with reordered arg keys to a single execution", async () => {
    // Iteration 0: emit web_search with args {a, b}.
    // Iteration 1: emit the SAME call but with keys reordered {b, a} — a raw
    //   JSON.stringify signature would treat this as new and re-execute it.
    //   stableSig sorts keys, so it must dedup and skip the second execution.
    //   The loop then detects every call this turn was a duplicate ("model
    //   stuck") and exits — so the executor runs exactly once total.
    const responses = [
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", function: { name: "web_search", arguments: JSON.stringify({ a: 1, b: 2 }) } },
        ],
      }),
      chatMessage({
        role: "assistant",
        content: "wrapping up",
        tool_calls: [
          { id: "c2", function: { name: "web_search", arguments: JSON.stringify({ b: 2, a: 1 }) } },
        ],
      }),
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

    const executor = vi.fn(async () => "search result");

    const result = await nvidia.runGeminiChat(
      null,
      "you are a test bot",
      [
        {
          name: "web_search",
          description: "Search the web",
          input_schema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
      ],
      [{ role: "user", parts: [{ text: "search" }] }],
      "search",
      executor,
      { useFastModel: false },
    );

    // Executor must run exactly once — the reordered-key duplicate was deduped.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith("web_search", { a: 1, b: 2 });
    // The duplicate-only turn exits the loop with that turn's content.
    expect(result.text).toBe("wrapping up");
    expect(result.toolsUsed).toEqual(["web_search"]);
  });
});
