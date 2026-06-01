import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { callEris, erisErrorText, execute, shouldUseGeminiGroundingForWebSearch } from "../../../ai/executors/advancedExecutor.js";
// @ts-expect-error - importing JS module without types
import { verifyTwinRequest } from "@defnotean/shared/twinSign";
// @ts-expect-error - importing JS module without types
import config from "../../../config.js";

// callEris is the helper that ask_eris uses to talk to Eris's /api/twin/*.
// Before this test existed, ask_eris was sending unsigned POSTs to a
// hardcoded URL — Eris's gate at dashboard.js:271-279 was silently 403'ing
// remind/note/fact for an unknown amount of time.

describe("callEris (ask_eris twin client)", () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url: string; init: any } | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = null;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: any) => {
      captured = { url: String(url), init: init || {} };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("signs POST requests with HMAC headers verifiable against the same secret", async () => {
    await callEris("/remind", {
      method: "POST",
      body: { user_id: "123", reminder_text: "test", remind_at: "2026-04-26T20:00:00Z" },
    });

    expect(captured).not.toBeNull();
    expect(captured!.init.method).toBe("POST");

    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-twin-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["x-twin-timestamp"]).toMatch(/^\d+$/);

    // The signed body the server would receive must verify against the
    // same secret the client used. This catches regressions where the
    // body is mutated after signing.
    const v = verifyTwinRequest(headers, captured!.init.body, config.twinApiSecret);
    expect(v.ok).toBe(true);
  });

  it("uses Bearer auth, not HMAC, for read-only GET requests", async () => {
    await callEris("/mood");
    expect(captured!.init.method).toBe("GET");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-twin-signature"]).toBeUndefined();
    expect(headers["x-twin-timestamp"]).toBeUndefined();
    expect(headers.Authorization).toBe(`Bearer ${config.twinApiSecret}`);
    expect(captured!.init.body).toBeUndefined();
  });

  it("hits the configured twinApiUrl, not the previously hardcoded URL", async () => {
    await callEris("/status");
    expect(captured!.url).toContain("/api/twin/status");
    expect(captured!.url).not.toContain("irene-bot.onrender.com");
    expect(captured!.url.startsWith(config.twinApiUrl)).toBe(true);
  });

  it("includes a Content-Type header on every call", async () => {
    await callEris("/note", { method: "POST", body: { user_id: "1", title: "t", content: "c" } });
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("signs the exact JSON body that gets sent (no after-sign mutation)", async () => {
    const payload = { user_id: "999", fact: "irene is the good twin" };
    await callEris("/fact", { method: "POST", body: payload });
    const headers = captured!.init.headers as Record<string, string>;
    // The body in the captured request must round-trip through verify with no edits.
    const v = verifyTwinRequest(headers, captured!.init.body, config.twinApiSecret);
    expect(v.ok).toBe(true);
    // And the body actually contains what we passed in.
    const parsed = JSON.parse(captured!.init.body);
    expect(parsed).toEqual(payload);
  });
});

// erisErrorText extracts a user-facing error string from whatever shape
// Eris returned. Before this helper, ask_eris would emit
// "eris couldn't set it up: undefined" when the response had no `error`
// field — confusing for the user and embarrassing for the bot. The helper
// also falls back to res.status when even that's missing.
describe("erisErrorText", () => {
  it("prefers data.error when present and non-empty", () => {
    expect(erisErrorText({ error: "permission denied" }, { status: 500 })).toBe("permission denied");
  });

  it("falls back to data.message when error is missing", () => {
    expect(erisErrorText({ message: "rate limited" }, { status: 429 })).toBe("rate limited");
  });

  it("falls back to data.reason when error and message are missing", () => {
    expect(erisErrorText({ reason: "guild has not opted in" }, { status: 200 })).toBe("guild has not opted in");
  });

  it("falls back to HTTP status when data has no useful field", () => {
    expect(erisErrorText({ success: false }, { status: 502 })).toBe("HTTP 502");
  });

  it("falls back to HTTP status when data is null (parse failure handled upstream)", () => {
    expect(erisErrorText(null, { status: 500 })).toBe("HTTP 500");
  });

  it("returns 'unknown error' as a last resort with no status either", () => {
    expect(erisErrorText(null, null as unknown as Response)).toBe("unknown error");
  });

  it("treats whitespace-only error fields as missing (avoids 'eris said: \"   \"')", () => {
    expect(erisErrorText({ error: "   " }, { status: 500 })).toBe("HTTP 500");
  });

  it("never returns the literal string 'undefined' (the original bug)", () => {
    const cases: Array<{ data: any; res: any }> = [
      { data: { error: undefined }, res: { status: 500 } },
      { data: { success: false }, res: { status: 500 } },
      { data: undefined, res: { status: 500 } },
      { data: {}, res: { status: 500 } },
    ];
    for (const c of cases) {
      const out = erisErrorText(c.data, c.res);
      expect(out).not.toContain("undefined");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("calculate executor", () => {
  it("evaluates arithmetic, functions, and assignment without expr-eval", async () => {
    const result = await execute("calculate", {
      expression: "x = 2 + 3 * 4; sqrt(x + 2)",
    }, {} as any, {} as any);

    expect(result).toBe("**4**  ← `x = 2 + 3 * 4; sqrt(x + 2)`");
  });

  it("blocks unsafe or unsupported expressions", async () => {
    await expect(execute("calculate", {
      expression: "constructor.constructor('return process')()",
    }, {} as any, {} as any)).resolves.toContain("Math error:");

    await expect(execute("calculate", {
      expression: "2 ** 99",
    }, {} as any, {} as any)).resolves.toContain("large exponents are forbidden");
  });
});

describe("web_search grounding selection", () => {
  const savedProvider = config.aiProvider;
  const savedOverride = process.env.WEB_SEARCH_GEMINI_GROUNDING;

  afterEach(() => {
    config.aiProvider = savedProvider;
    if (savedOverride === undefined) delete process.env.WEB_SEARCH_GEMINI_GROUNDING;
    else process.env.WEB_SEARCH_GEMINI_GROUNDING = savedOverride;
  });

  it("skips Gemini grounding when Irene is using OpenRouter", () => {
    config.aiProvider = "openrouter";
    delete process.env.WEB_SEARCH_GEMINI_GROUNDING;

    expect(shouldUseGeminiGroundingForWebSearch()).toBe(false);
  });

  it("keeps Gemini grounding for Gemini provider or explicit opt-in", () => {
    config.aiProvider = "gemini";
    delete process.env.WEB_SEARCH_GEMINI_GROUNDING;
    expect(shouldUseGeminiGroundingForWebSearch()).toBe(true);

    config.aiProvider = "openrouter";
    process.env.WEB_SEARCH_GEMINI_GROUNDING = "true";
    expect(shouldUseGeminiGroundingForWebSearch()).toBe(true);
  });
});
