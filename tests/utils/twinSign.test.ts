import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { signTwinRequest, verifyTwinRequest, TWIN_MAX_SKEW_MS } from "../../utils/twinSign.js";

const SECRET = "test-secret-hex-0123456789abcdef";

describe("twinSign", () => {
  it("round-trips a valid signed request", () => {
    const body = JSON.stringify({ command: "ban", target_id: "123" });
    const headers = signTwinRequest(body, SECRET);
    const result = verifyTwinRequest(headers, body, SECRET);
    expect(result.ok).toBe(true);
  });

  it("rejects when the secret differs", () => {
    const body = JSON.stringify({ command: "ban" });
    const headers = signTwinRequest(body, SECRET);
    const result = verifyTwinRequest(headers, body, "different-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bad signature/);
  });

  it("rejects when the body is tampered with", () => {
    const body = JSON.stringify({ command: "ban", target_id: "123" });
    const tampered = JSON.stringify({ command: "ban", target_id: "456" });
    const headers = signTwinRequest(body, SECRET);
    const result = verifyTwinRequest(headers, tampered, SECRET);
    expect(result.ok).toBe(false);
  });

  it("rejects when timestamp is outside the skew window", () => {
    const body = "{}";
    const now = Date.now();
    const headers = signTwinRequest(body, SECRET, now - TWIN_MAX_SKEW_MS - 1000);
    const result = verifyTwinRequest(headers, body, SECRET, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/skew/);
  });

  it("rejects when required headers are missing", () => {
    const result = verifyTwinRequest({}, "{}", SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing/);
  });

  it("rejects replay of the same signature within the skew window", () => {
    // Use a unique body to avoid colliding with other tests' replay cache
    const body = JSON.stringify({ command: "replay-check", nonce: Math.random() });
    const headers = signTwinRequest(body, SECRET);
    const first = verifyTwinRequest(headers, body, SECRET);
    const second = verifyTwinRequest(headers, body, SECRET);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/replay/);
  });

  it("throws if signing with no secret", () => {
    expect(() => signTwinRequest("{}", "")).toThrow();
  });
});
