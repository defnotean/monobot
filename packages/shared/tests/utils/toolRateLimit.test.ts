import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { checkToolRateLimit, _resetForTest } from "../../src/utils/toolRateLimit.js";

beforeEach(() => { _resetForTest(); });

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

  it("caps destructive delete/nuke-class tools at 3 per 5 minutes", () => {
    for (const tool of ["delete_channel", "nuke_channel", "delete_role", "mass_role"]) {
      for (let i = 0; i < 3; i++) {
        expect(checkToolRateLimit("destrtest1", tool).allowed).toBe(true);
      }
      const blocked = checkToolRateLimit("destrtest1", tool);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(300_000);
    }
  });

  it("caps ban/kick/purge at 5 per 5 minutes", () => {
    for (const tool of ["ban_user", "kick_user", "purge_messages"]) {
      for (let i = 0; i < 5; i++) {
        expect(checkToolRateLimit("destrtest2", tool).allowed).toBe(true);
      }
      expect(checkToolRateLimit("destrtest2", tool).allowed).toBe(false);
    }
  });

  it("caps lockdown_server at 3 per 5 minutes", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkToolRateLimit("destrtest3", "lockdown_server").allowed).toBe(true);
    }
    const blocked = checkToolRateLimit("destrtest3", "lockdown_server");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(300_000);
  });

  it("includes Irene-only entries (generate_image, say_tts)", () => {
    // Both are gated, so 5 calls hit the cap on generate_image
    for (let i = 0; i < 5; i++) {
      const r = checkToolRateLimit("ratetest4", "generate_image");
      expect(r.allowed).toBe(true);
    }
    expect(checkToolRateLimit("ratetest4", "generate_image").allowed).toBe(false);

    // say_tts is 10/min
    for (let i = 0; i < 10; i++) {
      const r = checkToolRateLimit("ratetest5", "say_tts");
      expect(r.allowed).toBe(true);
    }
    expect(checkToolRateLimit("ratetest5", "say_tts").allowed).toBe(false);
  });
});
