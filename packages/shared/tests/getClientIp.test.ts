import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module without .d.ts; types not needed here.
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

  it("uses the rightmost X-Forwarded-For hop (the closest trusted proxy's view)", () => {
    // Render appends each hop to the right; rightmost is what the nearest proxy
    // actually observed, so with a single trusted proxy it is the real client.
    const req = makeReq({ "x-forwarded-for": "198.51.100.5, 10.0.0.1" }, "10.0.0.1");
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("returns the single XFF value when there is exactly one hop", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5" }, "10.0.0.1");
    expect(getClientIp(req)).toBe("198.51.100.5");
  });

  it("ignores attacker-controlled leftmost hops with multiple trailing proxies", () => {
    // A client can forge anything in the leftmost slots; the rightmost is the
    // address our nearest trusted proxy prepended-to.
    const req = makeReq(
      { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 192.0.2.9" },
      "10.0.0.1"
    );
    expect(getClientIp(req)).toBe("192.0.2.9");
  });

  it("trims surrounding whitespace on the chosen hop", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.5,  10.0.0.1  " }, "10.0.0.1");
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("handles X-Forwarded-For delivered as an array of values", () => {
    const req = makeReq({ "x-forwarded-for": ["198.51.100.5", "10.0.0.1"] }, "10.0.0.1");
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("falls back to socket when XFF is present but empty/whitespace-only", () => {
    const req = makeReq({ "x-forwarded-for": "  ,  " }, "203.0.113.7");
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("returns 'unknown' when no IP is resolvable at all", () => {
    const req = makeReq({}, undefined);
    expect(getClientIp(req)).toBe("unknown");
  });
});
