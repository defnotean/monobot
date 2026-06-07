import { describe, expect, it, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { handleAdminAuxRoute, remapIreneProxyPath } from "../../api/adminAuxRoutes.js";

type MockReq = {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on: (event: string, cb: (chunk?: string) => void) => MockReq;
};

type MockRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (k: string, v: string) => void;
  writeHead: (code: number, headers?: Record<string, string>) => void;
  end: (chunk?: string) => void;
};

function makeReq(path: string, headers: Record<string, string> = {}, ip = "203.0.113.10"): MockReq {
  return {
    url: path,
    method: "GET",
    headers,
    socket: { remoteAddress: ip },
    on() { return this; },
  };
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(k: string, v: string) { res.headers[k.toLowerCase()] = v; },
    writeHead(code: number, headers?: Record<string, string>) {
      res.statusCode = code;
      for (const [k, v] of Object.entries(headers || {})) res.headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string) { if (chunk) res.body = chunk; },
  };
  return res;
}

beforeEach(() => {
  process.env.TWIN_API_SECRET = "test-twin-secret";
  process.env.DASHBOARD_API_KEY = "dashboard-key";
  delete process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS;
});

describe("Eris admin auxiliary routes", () => {
  it("maps Irene readiness probes to top-level Irene probe paths", () => {
    expect(remapIreneProxyPath("/api/irene/healthz")).toBe("/healthz");
    expect(remapIreneProxyPath("/api/irene/readyz?bot=irene")).toBe("/readyz?bot=irene");
    expect(remapIreneProxyPath("/api/irene/stats")).toBe("/api/stats");
  });

  it("normalizes only the proxied path and preserves query URL values", () => {
    expect(remapIreneProxyPath("/api//irene//stats?target=https://example.com//asset")).toBe(
      "/api/stats?target=https://example.com//asset",
    );
  });

  it("rejects unauthenticated remote /api/irene proxy requests before proxying", async () => {
    const res = makeRes();

    const handled = await handleAdminAuxRoute(makeReq("/api/irene/stats"), res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("unauthorized");
  });

  it("rejects unauthenticated remote /api/logs requests before reading logs", async () => {
    const res = makeRes();

    const handled = await handleAdminAuxRoute(makeReq("/api/logs?bot=eris&lines=50"), res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("unauthorized");
  });

  it("rejects localhost dashboard requests unless the dev bypass is explicitly enabled", async () => {
    const res = makeRes();

    const handled = await handleAdminAuxRoute(
      makeReq("/api/logs?bot=nonexistent&lines=10", {}, "127.0.0.1"),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("allows localhost dashboard requests when the explicit dev bypass is enabled", async () => {
    process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS = "1";
    const res = makeRes();

    const handled = await handleAdminAuxRoute(
      makeReq("/api/logs?bot=nonexistent&lines=10", {}, "127.0.0.1"),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).not.toBe(401);
  });

  // Regression for the hardening gap: handleAdminAuxRoute runs BEFORE
  // handleApiRequest, where the per-IP dashboard limiter lives. So
  // before the fix, an AUTHED caller could hammer /api/logs and /api/irene/*
  // without ever tripping a 429. These assert the shared limiter now fires.
  it("rate-limits authed aux-route requests after 180 hits in the window (181st gets 429)", async () => {
    // Unique remote IP so this test's bucket is isolated from any other test
    // that touched the shared module-level _dashboardLimiter for a known IP.
    const ip = "198.51.100.31";
    const auth = { authorization: "Bearer dashboard-key" };

    // First 180 authed requests are under the per-IP limit. They are authed
    // (valid Bearer) and hit a nonexistent log (404), so never a 401 or 429.
    for (let i = 0; i < 180; i++) {
      const res = makeRes();
      const handled = await handleAdminAuxRoute(
        makeReq("/api/logs?bot=nonexistent&lines=10", auth, ip),
        res,
      );
      expect(handled).toBe(true);
      expect(res.statusCode).not.toBe(429);
      expect(res.statusCode).not.toBe(401);
    }

    // The 181st authed request within the same window must be rate limited.
    const limitedRes = makeRes();
    const limitedHandled = await handleAdminAuxRoute(
      makeReq("/api/logs?bot=nonexistent&lines=10", auth, ip),
      limitedRes,
    );
    expect(limitedHandled).toBe(true);
    expect(limitedRes.statusCode).toBe(429);
    expect(JSON.parse(limitedRes.body).error).toBe("rate limited");
  });

  it("lets a single authed aux-route request through (rate limit not over-eager)", async () => {
    // Distinct IP again so the burst above doesn't bleed into this assertion.
    const res = makeRes();
    const handled = await handleAdminAuxRoute(
      makeReq("/api/logs?bot=nonexistent&lines=10", { authorization: "Bearer dashboard-key" }, "198.51.100.77"),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).not.toBe(429);
    expect(res.statusCode).not.toBe(401);
  });
});
