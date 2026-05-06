import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBraveAnswerPayload, formatBraveSearchPayload, performWebSearch } from "../src/ai/webSearchEngine.js";

describe("webSearchEngine Brave support", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses Brave Answers before Brave Search when an answers key is configured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "to crack someone means to tease or mess with them" } }],
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await performWebSearch("crack someone slang", {
      braveAnswersApiKey: "answers-key",
      braveSearchApiKey: "search-key",
      braveAnswersModel: "brave",
    }, 1000);

    expect(out).toContain("Brave Answers");
    expect(out).toContain("tease or mess with them");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.search.brave.com/res/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("answers-key");
    expect(JSON.parse(String(init.body)).model).toBe("brave");
  });

  it("falls back to Brave Search with extra snippets when Brave Answers is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        web: {
          results: [{
            title: "Crack slang definition",
            description: "A slang definition.",
            extra_snippets: ["Often means teasing or getting a reaction."],
            url: "https://example.test/crack",
          }],
        },
      }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await performWebSearch("crack someone slang", {
      braveAnswersApiKey: "answers-key",
      braveSearchApiKey: "search-key",
    }, 1000);

    expect(out).toContain("Crack slang definition");
    expect(out).toContain("Often means teasing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(url).toContain("extra_snippets=true");
    expect(url).toContain("text_decorations=false");
    expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("search-key");
  });

  it("does not spend the full tool timeout waiting for slow Brave Answers", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        web: {
          results: [{
            title: "Fast search fallback",
            description: "Search results came back quickly.",
            url: "https://example.test/fast",
          }],
        },
      }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const started = Date.now();
    const out = await performWebSearch("crack someone slang", {
      braveAnswersApiKey: "answers-key",
      braveSearchApiKey: "search-key",
      braveAnswersTimeoutMs: 20,
      braveSearchTimeoutMs: 500,
    }, 1000);

    expect(Date.now() - started).toBeLessThan(900);
    expect(out).toContain("Fast search fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("formats Brave payloads without empty snippet noise", () => {
    expect(formatBraveAnswerPayload({
      choices: [{ message: { content: "<answer>short answer</answer><usage>ignore</usage>" } }],
    })).toBe("Brave Answers:\nshort answer");

    expect(formatBraveSearchPayload({
      web: { results: [{ title: "Title", description: "", extra_snippets: ["extra"], url: "https://example.test" }] },
    })).toBe("1. Title\n   extra\n   https://example.test");

    expect(formatBraveSearchPayload({
      discussions: { results: [{ title: "Forum answer", description: "discussion snippet", url: "https://example.test/thread" }] },
    })).toBe("1. Forum answer\n   discussion snippet\n   https://example.test/thread");
  });
});
