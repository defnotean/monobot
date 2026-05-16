// Smoke test verifying Eris's executor still resolves the shared toolRateLimit
// module. The full test suite lives in @defnotean/shared/tests; this file is
// intentionally small — it would catch a broken re-export or a missing dep.
import { describe, it, expect } from "vitest";
// @ts-expect-error
import { checkToolRateLimit } from "@defnotean/shared/toolRateLimit";

describe("checkToolRateLimit (via @defnotean/shared)", () => {
  it("is callable and returns the expected shape", () => {
    const result = checkToolRateLimit("eris-smoke-user", "check_balance");
    expect(result).toEqual({ allowed: true });
  });

  it("blocks scrape_url after 5 hits in a minute", () => {
    for (let i = 0; i < 5; i++) checkToolRateLimit("eris-smoke-block", "scrape_url");
    const result = checkToolRateLimit("eris-smoke-block", "scrape_url");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks per-user state (different users dont share buckets)", () => {
    for (let i = 0; i < 5; i++) checkToolRateLimit("eris-smoke-A", "analyze_image");
    const result = checkToolRateLimit("eris-smoke-B", "analyze_image");
    expect(result.allowed).toBe(true);
  });

  it("tracks per-tool state (different tools dont share buckets)", () => {
    for (let i = 0; i < 10; i++) checkToolRateLimit("eris-smoke-tool", "web_search");
    const result = checkToolRateLimit("eris-smoke-tool", "scrape_url");
    expect(result.allowed).toBe(true);
  });

  it("allows unlimited use of unlisted tools", () => {
    for (let i = 0; i < 50; i++) {
      const result = checkToolRateLimit("eris-smoke-unlisted", "check_balance");
      expect(result.allowed).toBe(true);
    }
  });
});
