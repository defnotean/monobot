import { describe, expect, it, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { handleAdminAuxRoute } from "../../api/adminAuxRoutes.js";

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
  delete process.env.DASHBOARD_API_KEY;
});

describe("Eris admin auxiliary routes", () => {
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

  it("allows localhost dashboard requests through the auxiliary route gate", async () => {
    const res = makeRes();

    const handled = await handleAdminAuxRoute(
      makeReq("/api/logs?bot=nonexistent&lines=10", {}, "127.0.0.1"),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).not.toBe(401);
  });
});
