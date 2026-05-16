import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { isOriginAllowed } from "../../api/dashboard.js";

describe("dashboard CORS origin matching", () => {
  const allowed = [
    "https://eris.example.com",
    "https://twin.example.com",
    "http://localhost:3000",
  ];

  it("allows an exact-origin match (scheme + host + port)", () => {
    expect(isOriginAllowed("https://eris.example.com", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", allowed)).toBe(true);
  });

  it("rejects the classic subdomain-suffix bypass that startsWith permitted", () => {
    // The bug: `"https://eris.example.com.attacker.com".startsWith("https://eris.example.com")` is true.
    // Exact-origin match must say no.
    expect(isOriginAllowed("https://eris.example.com.attacker.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://eris.example.com.evil.io", allowed)).toBe(false);
    expect(isOriginAllowed("https://twin.example.com.attacker.com/path", allowed)).toBe(false);
  });

  it("rejects scheme, host, port, and malformed mismatches", () => {
    // Different scheme.
    expect(isOriginAllowed("http://eris.example.com", allowed)).toBe(false);
    // Different host entirely.
    expect(isOriginAllowed("https://attacker.com", allowed)).toBe(false);
    // Different port on localhost.
    expect(isOriginAllowed("http://localhost:4000", allowed)).toBe(false);
    // Path-suffixed garbage that some naive parsers accept.
    expect(isOriginAllowed("https://eris.example.com@attacker.com", allowed)).toBe(false);
    // Empty / non-string / unparseable input.
    expect(isOriginAllowed("", allowed)).toBe(false);
    expect(isOriginAllowed(null as unknown as string, allowed)).toBe(false);
    expect(isOriginAllowed("not-a-url", allowed)).toBe(false);
  });
});
