import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { execute as executeWeb, shouldUseGeminiGroundingForWebSearch } from "../../../ai/executors/webExecutor.js";
// @ts-expect-error - importing JS module without types
import config from "../../../config.js";

// Smoke tests: scrape_url must (a) refuse SSRF targets via safeFetch,
// (b) wrap successful output in the [UNTRUSTED EXTERNAL CONTENT] envelope.

const fakeMessage = { author: { id: "owner-test" } } as any;

describe("scrape_url (eris webExecutor)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("refuses to fetch a loopback URL", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await executeWeb("scrape_url", { url: "http://127.0.0.1/admin" }, fakeMessage, {});
    expect(out).toMatch(/scrape failed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses file:// URL", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await executeWeb("scrape_url", { url: "file:///etc/passwd" }, fakeMessage, {});
    expect(out).toMatch(/scrape failed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Note: a "wraps successful output" smoke test is in irene's web_read suite
  // (irene's tests/ai/executors/webExecutor.test.ts) — eris's scrape_url
  // depends on cheerio at runtime which is not installed under tests.
});

describe("web_search grounding selection (eris webExecutor)", () => {
  const savedProvider = config.aiProvider;
  const savedOverride = process.env.WEB_SEARCH_GEMINI_GROUNDING;

  afterEach(() => {
    config.aiProvider = savedProvider;
    if (savedOverride === undefined) delete process.env.WEB_SEARCH_GEMINI_GROUNDING;
    else process.env.WEB_SEARCH_GEMINI_GROUNDING = savedOverride;
  });

  it("skips Gemini grounding when Eris is using OpenRouter", () => {
    config.aiProvider = "openrouter";
    delete process.env.WEB_SEARCH_GEMINI_GROUNDING;

    expect(shouldUseGeminiGroundingForWebSearch()).toBe(false);
  });

  it("keeps Gemini grounding for Gemini provider or explicit opt-in", () => {
    config.aiProvider = "gemini";
    delete process.env.WEB_SEARCH_GEMINI_GROUNDING;
    expect(shouldUseGeminiGroundingForWebSearch()).toBe(true);

    config.aiProvider = "openrouter";
    process.env.WEB_SEARCH_GEMINI_GROUNDING = "on";
    expect(shouldUseGeminiGroundingForWebSearch()).toBe(true);
  });
});
