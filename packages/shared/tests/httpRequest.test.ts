import { describe, expect, it } from "vitest";
import { normalizeRequestPathname, parseRequestUrl } from "../src/httpRequest.js";

describe("http request URL helpers", () => {
  it("parses origin-form request targets against the supplied base", () => {
    const url = parseRequestUrl("/api/health?verbose=1", "http://localhost:3000");

    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/api/health");
    expect(url.searchParams.get("verbose")).toBe("1");
  });

  it("falls back to root for malformed absolute-form request targets", () => {
    const url = parseRequestUrl("http://%zz/api/health", "http://localhost:3000");

    expect(url.href).toBe("http://localhost:3000/");
    expect(url.pathname).toBe("/");
  });

  it("normalizes duplicate path slashes without rewriting query values", () => {
    const url = parseRequestUrl(
      "/api//stats?target=https://example.com//asset",
      "http://localhost:3000",
    );

    expect(normalizeRequestPathname(url.pathname)).toBe("/api/stats");
    expect(url.searchParams.get("target")).toBe("https://example.com//asset");
  });

  it("treats double-slash request targets as origin-form paths, not protocol-relative URLs", () => {
    const health = parseRequestUrl("//healthz", "http://localhost:3000");
    const api = parseRequestUrl("//api/health", "http://localhost:3000");
    const tts = parseRequestUrl("//tts/clip-id", "http://localhost:3000");

    expect(normalizeRequestPathname(health.pathname)).toBe("/healthz");
    expect(normalizeRequestPathname(api.pathname)).toBe("/api/health");
    expect(normalizeRequestPathname(tts.pathname)).toBe("/tts/clip-id");
  });
});
