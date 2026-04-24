import { describe, it, expect } from "vitest";
import { checkToolRateLimit } from "../../utils/toolRateLimit.js";

describe("checkToolRateLimit", () => {
  it("allows non-rate-limited tools", () => {
    const result = checkToolRateLimit("user1", "check_balance");
    expect(result.allowed).toBe(true);
  });

  it("allows rate-limited tools within limits", () => {
    // web_search allows 10 per minute
    for (let i = 0; i < 10; i++) {
      const result = checkToolRateLimit("ratetest1", "web_search");
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks rate-limited tools over limits", () => {
    // scrape_url allows 5 per minute
    for (let i = 0; i < 5; i++) {
      checkToolRateLimit("ratetest2", "scrape_url");
    }
    const result = checkToolRateLimit("ratetest2", "scrape_url");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("tracks limits per user independently", () => {
    // Fill up user A
    for (let i = 0; i < 5; i++) {
      checkToolRateLimit("userA", "analyze_image");
    }
    // User B should still be allowed
    const result = checkToolRateLimit("userB", "analyze_image");
    expect(result.allowed).toBe(true);
  });

  it("tracks limits per tool independently", () => {
    // Fill up web_search for a user
    for (let i = 0; i < 10; i++) {
      checkToolRateLimit("ratetest3", "web_search");
    }
    // scrape_url should still be allowed for same user
    const result = checkToolRateLimit("ratetest3", "scrape_url");
    expect(result.allowed).toBe(true);
  });
});
