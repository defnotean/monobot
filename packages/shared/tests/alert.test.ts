import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the SSRF-safe transport so no real network I/O happens. The factory
// hoists above the imports, so reference the spy via the returned module.
vi.mock("../src/safeFetch.js", () => ({
  safeFetch: vi.fn(async () => ({ status: 204, headers: new Map(), text: "", url: "" })),
}));

// @ts-expect-error — JS modules without .d.ts; types not needed here.
import { safeFetch } from "../src/safeFetch.js";
// @ts-expect-error — JS module without .d.ts.
import { sendAlert, _resetAlertState } from "../src/alert.js";

const mockedFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;
const WEBHOOK = "https://discord.com/api/webhooks/123/abc";

describe("sendAlert", () => {
  beforeEach(() => {
    mockedFetch.mockClear();
    mockedFetch.mockResolvedValue({ status: 204, headers: new Map(), text: "", url: "" });
    _resetAlertState();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it("is a no-op (no fetch) when ALERT_WEBHOOK_URL is unset", async () => {
    const sent = await sendAlert("uncaught-exception", "boom");
    expect(sent).toBe(false);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("treats a blank ALERT_WEBHOOK_URL as unset", async () => {
    process.env.ALERT_WEBHOOK_URL = "   ";
    const sent = await sendAlert("uncaught-exception", "boom");
    expect(sent).toBe(false);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("POSTs once and de-dupes a second identical alert inside the window", async () => {
    const first = await sendAlert("uncaught-exception", "boom", { webhookUrl: WEBHOOK, now: 1_000 });
    expect(first).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Same kind, 30s later — inside the 60s window → suppressed.
    const second = await sendAlert("uncaught-exception", "boom again", { webhookUrl: WEBHOOK, now: 31_000 });
    expect(second).toBe(false);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("sends again once the dedupe window has elapsed", async () => {
    await sendAlert("uncaught-exception", "boom", { webhookUrl: WEBHOOK, now: 1_000 });
    // 61s later — outside the window → allowed.
    const again = await sendAlert("uncaught-exception", "boom", { webhookUrl: WEBHOOK, now: 62_000 });
    expect(again).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("de-dupes per kind — different kinds both get through", async () => {
    await sendAlert("persistence-unhealthy", "down", { webhookUrl: WEBHOOK, now: 1_000 });
    const recovery = await sendAlert("persistence-recovered", "up", { webhookUrl: WEBHOOK, now: 1_500 });
    expect(recovery).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("POSTs a JSON embed payload to the webhook URL", async () => {
    await sendAlert("uncaught-exception", "kaboom", { webhookUrl: WEBHOOK, bot: "ERIS", now: 0 });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockedFetch.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.embeds[0].title).toContain("ERIS");
    expect(body.embeds[0].description).toBe("kaboom");
  });

  it("swallows fetch errors and never throws into the caller", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("network down"));
    const log = vi.fn();
    const result = await sendAlert("uncaught-exception", "boom", { webhookUrl: WEBHOOK, log, now: 0 });
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("send failed"));
  });

  it("does not throw even without a log callback when fetch rejects", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("boom"));
    await expect(
      sendAlert("uncaught-exception", "x", { webhookUrl: WEBHOOK, now: 0 }),
    ).resolves.toBe(false);
  });

  // P2 #10 — sendAlert must redact at the source so no caller (e.g. a crash
  // handler passing a raw err.message) can leak a secret into the webhook.
  // logRedact is intentionally NOT mocked: these assert the real patterns.
  describe("redaction", () => {
    /** Pull the embed description out of the last webhook POST body. */
    function lastDescription(): string {
      const [, opts] = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1];
      return JSON.parse(opts.body).embeds[0].description;
    }

    it("redacts provider-prefixed API keys (sk-...) from the payload", async () => {
      await sendAlert("uncaught-exception", "upstream 401: invalid key sk-FAKEFAKEFAKEFAKEFAKE12345", { webhookUrl: WEBHOOK, now: 0 });
      const desc = lastDescription();
      expect(desc).not.toContain("sk-FAKEFAKEFAKEFAKEFAKE12345");
      expect(desc).toContain("[REDACTED]");
      // Non-secret context survives so the alert is still actionable.
      expect(desc).toContain("upstream 401: invalid key");
    });

    it("redacts Authorization header credentials but keeps the scheme", async () => {
      await sendAlert("uncaught-exception", "fetch failed: Authorization: Bearer SuperSecretValue1234567890", { webhookUrl: WEBHOOK, now: 0 });
      const desc = lastDescription();
      expect(desc).not.toContain("SuperSecretValue1234567890");
      expect(desc).toContain("Bearer [REDACTED]");
    });

    it("redacts query-string tokens in URLs but keeps the param name", async () => {
      await sendAlert("uncaught-exception", "GET https://api.example.com/v1/search?api_key=AbCd1234EfGh5678 -> 401", { webhookUrl: WEBHOOK, now: 0 });
      const desc = lastDescription();
      expect(desc).not.toContain("AbCd1234EfGh5678");
      expect(desc).toContain("api_key=[REDACTED]");
      expect(desc).toContain("https://api.example.com/v1/search");
    });

    it("redacts known secret env-var values (highest-confidence path)", async () => {
      const prev = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "supersecret-gemini-value-9876";
      try {
        await sendAlert("uncaught-exception", "provider rejected supersecret-gemini-value-9876", { webhookUrl: WEBHOOK, now: 0 });
      } finally {
        if (prev === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prev;
      }
      const desc = lastDescription();
      expect(desc).not.toContain("supersecret-gemini-value-9876");
      expect(desc).toContain("[REDACTED]");
    });

    it("redacts BEFORE the 2000-char slice so a token cut in half can't slip through", async () => {
      // The token STRADDLES the 2000-char boundary: "Bearer " ends at index
      // 1992, so the token's first 7 chars ("SECRETt", indices 1993-1999) land
      // inside the slice window. Slicing FIRST would hand the redactor a 7-char
      // fragment — below the Bearer pattern's {8,} minimum, unredactable — and
      // this test would fail. Redact-first leaves no fragment at all.
      const message = "p".repeat(1985) + " Bearer SECRETtok12345678";
      await sendAlert("uncaught-exception", message, { webhookUrl: WEBHOOK, now: 0 });
      const desc = lastDescription();
      expect(desc.length).toBeLessThanOrEqual(2000);
      expect(desc).not.toContain("SECRET");
    });
  });
});
