import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBraveAnswerPayload, formatBraveSearchPayload, performWebSearch } from "../src/ai/webSearchEngine.js";

// safeFetch (which now backs every backend in webSearchEngine) does a
// dns.lookup before issuing the request. Pin the resolver to a public IP so
// unit tests don't depend on real DNS and the SSRF guard sees a public host.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "1.2.3.4", family: 4 })),
}));

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

  it("falls back to Brave Search when Brave Answers only says it has no context", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'The provided search results do not contain any information about "jtmachina." Therefore, I cannot provide a relevant answer.',
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        web: {
          results: [{
            title: "JT Machina",
            description: "A creator profile surfaced by web search.",
            url: "https://example.test/jtmachina",
          }],
        },
      }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await performWebSearch("jtmachina", {
      braveAnswersApiKey: "answers-key",
      braveSearchApiKey: "search-key",
    }, 1000);

    expect(out).toContain("JT Machina");
    expect(out).toContain("creator profile");
    expect(out).not.toContain("Brave Answers");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    expect(formatBraveAnswerPayload({
      choices: [{ message: { content: "No information is available in the provided context." } }],
    })).toBe("");

    expect(formatBraveSearchPayload({
      web: { results: [{ title: "Title", description: "", extra_snippets: ["extra"], url: "https://example.test" }] },
    })).toBe("1. Title\n   extra\n   https://example.test");

    expect(formatBraveSearchPayload({
      discussions: { results: [{ title: "Forum answer", description: "discussion snippet", url: "https://example.test/thread" }] },
    })).toBe("1. Forum answer\n   discussion snippet\n   https://example.test/thread");
  });
});

describe("webSearchEngine SSRF guard for SearxNG", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("refuses a SearxNG template that points at a private/loopback host", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // No public-network backends configured. SearxNG points at loopback —
    // safeFetch's sync URL validator should reject it BEFORE any fetch happens.
    // We expect the engine to fall through to the DDG fallback (which will
    // also be routed through safeFetch and hit the mock).
    fetchMock.mockResolvedValueOnce(new Response("<html><body></body></html>", { status: 200 }));

    await performWebSearch("anything", {
      searxngQueryUrl: "http://127.0.0.1:8888/search?q=<query>&format=json",
    }, 1000);

    // No call should have been made to a loopback host — the only fetch
    // is the DDG fallback (a public domain).
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const [url] = call as [string, RequestInit];
      expect(url).not.toContain("127.0.0.1");
    }
  });

  it("refuses a SearxNG template with file:// scheme", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response("<html><body></body></html>", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await performWebSearch("anything", {
      searxngQueryUrl: "file:///etc/passwd?q=<query>",
    }, 1000);

    for (const call of fetchMock.mock.calls) {
      const [url] = call as [string, RequestInit];
      expect(url.startsWith("file://")).toBe(false);
    }
  });
});
