import { describe, expect, it } from "vitest";
// @ts-expect-error - JS module without .d.ts; types not needed here.
import { getClientIp } from "../src/getClientIp.js";

// Minimal IncomingMessage-shaped stub: getClientIp only reads headers + socket.
function makeReq(headers: Record<string, string | string[]> = {}, remoteAddress?: string) {
  return { headers, socket: { remoteAddress } };
}

describe("getClientIp", () => {
  it("falls back to socket.remoteAddress when X-Forwarded-For is absent", () => {
    const req = makeReq({}, "203.0.113.7");
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("ignores spoofed X-Forwarded-For by default on direct deployments", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5" }, "203.0.113.7");
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("ignores attacker-controlled multi-hop X-Forwarded-For by default", () => {
    const req = makeReq(
      { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 192.0.2.9" },
      "203.0.113.7",
    );
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("uses the rightmost X-Forwarded-For hop when proxy trust is explicit", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5, 10.0.0.1" }, "10.0.0.1");
    expect(getClientIp(req, { trustProxy: true })).toBe("10.0.0.1");
  });

  it("returns the single XFF value when a trusted proxy reports exactly one hop", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5" }, "10.0.0.1");
    expect(getClientIp(req, { trustProxy: true })).toBe("198.51.100.5");
  });

  it("trims surrounding whitespace on the trusted hop", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5,  10.0.0.1  " }, "10.0.0.1");
    expect(getClientIp(req, { trustProxy: true })).toBe("10.0.0.1");
  });

  it("handles X-Forwarded-For delivered as an array when trusted", () => {
    const req = makeReq({ "x-forwarded-for": ["198.51.100.5", "10.0.0.1"] }, "10.0.0.1");
    expect(getClientIp(req, { trustProxy: true })).toBe("10.0.0.1");
  });

  it("trusts proxy headers when MONOBOT_TRUST_PROXY_HEADERS is enabled", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5" }, "10.0.0.1");
    expect(getClientIp(req, { env: { MONOBOT_TRUST_PROXY_HEADERS: "true" } })).toBe("198.51.100.5");
  });

  it("trusts proxy headers in Render web service context", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5" }, "10.0.0.1");
    expect(getClientIp(req, {
      env: { RENDER: "true", RENDER_SERVICE_TYPE: "web" },
    })).toBe("198.51.100.5");
  });

  it("lets an explicit false env setting override Render platform detection", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5" }, "10.0.0.1");
    expect(getClientIp(req, {
      env: {
        MONOBOT_TRUST_PROXY_HEADERS: "false",
        RENDER: "true",
        RENDER_SERVICE_TYPE: "web",
      },
    })).toBe("10.0.0.1");
  });

  it("falls back to socket when trusted XFF is present but empty/whitespace-only", () => {
    const req = makeReq({ "x-forwarded-for": "  ,  " }, "203.0.113.7");
    expect(getClientIp(req, { trustProxy: true })).toBe("203.0.113.7");
  });

  it("returns 'unknown' when no IP is resolvable at all", () => {
    const req = makeReq({}, undefined);
    expect(getClientIp(req)).toBe("unknown");
  });
});
