import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { signTwinRequest, verifyTwinRequest, safeStringEqual, TWIN_MAX_SKEW_MS, _REPLAY_CACHE_PRESSURE, _resetReplayCacheForTests } from "@defnotean/shared/twinSign";

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

  // Regression — under sustained flood, the previous size-based eviction
  // would silently drop oldest-inserted entries even when they were still
  // inside the skew window, opening a replay window for an attacker who
  // captured an early signature and then churned the Map. The fix flips to
  // fail-loud: once the cache hits _REPLAY_CACHE_PRESSURE entries that are
  // all in-window, refuse new requests with reason "replay-cache-pressure"
  // rather than evicting a legitimate prior entry.
  describe("replay cache pressure (regression)", () => {
    beforeEach(() => {
      _resetReplayCacheForTests();
    });

    it("refuses new requests with 'replay-cache-pressure' once 11000 distinct sigs are seen in-window", () => {
      // We pin `now` so every entry is treated as in-window — this is the
      // attack scenario, not a slow drip across a full skew window.
      const now = Date.now();

      // Fill the cache up to 11000 entries — well above _REPLAY_CACHE_PRESSURE.
      // Each request signs a unique body, so signatures are distinct and the
      // replay branch never fires. We expect the first PRESSURE entries to
      // succeed and everything after to be rejected with replay-cache-pressure.
      let acceptedBeforePressure = 0;
      const FLOOD = 11_000;
      for (let i = 0; i < FLOOD; i++) {
        const body = JSON.stringify({ i, nonce: `flood-${i}` });
        const headers = signTwinRequest(body, SECRET, now);
        const r = verifyTwinRequest(headers, body, SECRET, now);
        if (r.ok) acceptedBeforePressure++;
        else {
          expect(r.reason).toBe("replay-cache-pressure");
          break;
        }
      }
      expect(acceptedBeforePressure).toBe(_REPLAY_CACHE_PRESSURE);

      // The 11001st correct sig must be rejected — NOT silently accepted via
      // eviction of an earlier in-window entry. (Same `now` so nothing has
      // aged out.)
      const latePayload = JSON.stringify({ late: true, nonce: "11001st" });
      const lateHeaders = signTwinRequest(latePayload, SECRET, now);
      const late = verifyTwinRequest(lateHeaders, latePayload, SECRET, now);
      expect(late.ok).toBe(false);
      if (!late.ok) expect(late.reason).toBe("replay-cache-pressure");
    });

    it("recovers — once entries age past 2× the skew window they are pruned and new sigs accepted again", () => {
      const t0 = Date.now();

      // Fill to pressure.
      for (let i = 0; i < _REPLAY_CACHE_PRESSURE; i++) {
        const body = JSON.stringify({ i, nonce: `recover-${i}` });
        const headers = signTwinRequest(body, SECRET, t0);
        verifyTwinRequest(headers, body, SECRET, t0);
      }

      // Confirm we're in pressure.
      const blockedBody = JSON.stringify({ blocked: true });
      const blockedHeaders = signTwinRequest(blockedBody, SECRET, t0);
      const blocked = verifyTwinRequest(blockedHeaders, blockedBody, SECRET, t0);
      expect(blocked.ok).toBe(false);

      // Jump past 2× the skew window — the old entries should be pruned.
      const tLater = t0 + TWIN_MAX_SKEW_MS * 2 + 1000;
      const recoverBody = JSON.stringify({ recovered: true });
      const recoverHeaders = signTwinRequest(recoverBody, SECRET, tLater);
      const recovered = verifyTwinRequest(recoverHeaders, recoverBody, SECRET, tLater);
      expect(recovered.ok).toBe(true);
    });
  });

  describe("safeStringEqual", () => {
    it("returns true for equal strings", () => {
      expect(safeStringEqual("hello", "hello")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(safeStringEqual("hello", "world")).toBe(false);
    });

    it("returns false for differing lengths (the length check is the first hop)", () => {
      expect(safeStringEqual("a", "aa")).toBe(false);
      expect(safeStringEqual("aa", "a")).toBe(false);
    });

    it("returns false for non-string inputs", () => {
      expect(safeStringEqual(undefined, "x")).toBe(false);
      expect(safeStringEqual("x", undefined)).toBe(false);
      expect(safeStringEqual(null, null)).toBe(false);
      expect(safeStringEqual(123 as unknown as string, "123")).toBe(false);
      expect(safeStringEqual({} as unknown as string, {} as unknown as string)).toBe(false);
    });

    it("handles empty strings", () => {
      expect(safeStringEqual("", "")).toBe(true);
      expect(safeStringEqual("", "x")).toBe(false);
    });
  });
});
