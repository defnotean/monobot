import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { callEris } from "../../../ai/executors/advancedExecutor.js";
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

  it("does NOT sign GET requests (Eris's /api/twin gate is POST-only)", async () => {
    await callEris("/mood");
    expect(captured!.init.method).toBe("GET");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-twin-signature"]).toBeUndefined();
    expect(headers["x-twin-timestamp"]).toBeUndefined();
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
