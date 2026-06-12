import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { execute as executeAdvanced } from "../../../ai/executors/advancedExecutor.js";

// Smoke tests: scrape_url must (a) refuse SSRF targets via safeFetch,
// (b) wrap successful output in the [UNTRUSTED EXTERNAL CONTENT] envelope.

const fakeMessage = { author: { id: "owner-test" } } as any;
const fakeCtx = { webRateLimitPerMin: 1000 } as any;

describe("scrape_url (irene advancedExecutor)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("refuses a loopback URL", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await executeAdvanced("scrape_url", { url: "http://127.0.0.1/admin" }, fakeMessage, fakeCtx);
    expect(String(out)).toMatch(/Failed to read page/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses file:// URL", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await executeAdvanced("scrape_url", { url: "file:///etc/passwd" }, fakeMessage, fakeCtx);
    expect(String(out)).toMatch(/Failed to read page/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses 169.254.169.254 (cloud metadata)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const out = await executeAdvanced("scrape_url", { url: "http://169.254.169.254/latest/meta-data/" }, fakeMessage, fakeCtx);
    expect(String(out)).toMatch(/Failed to read page/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wraps successful output in untrusted envelope", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      "<html><body>Hello from somewhere on the public web</body></html>",
      { status: 200 }
    )) as any;

    const out = await executeAdvanced("scrape_url", { url: "https://1.1.1.1/page" }, fakeMessage, fakeCtx);
    expect(String(out)).toContain("[UNTRUSTED EXTERNAL CONTENT");
    expect(String(out)).toContain("Hello from somewhere on the public web");
    expect(String(out)).toContain("[END UNTRUSTED EXTERNAL CONTENT]");
  });
});
