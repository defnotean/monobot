import { describe, expect, it, vi } from "vitest";

const mockHttp = vi.hoisted(() => {
  const state: { handler: null | ((req: any, res: any) => unknown) } = { handler: null };
  const server: any = {
    requestTimeout: 0,
    headersTimeout: 0,
    keepAliveTimeout: 0,
    setTimeout: vi.fn(),
    on: vi.fn(),
    listen: vi.fn((_port: number, cb?: () => void) => {
      cb?.();
      return server;
    }),
  };
  return {
    state,
    server,
    createServer: vi.fn((handler: (req: any, res: any) => unknown) => {
      state.handler = handler;
      return server;
    }),
  };
});

vi.mock("http", () => ({
  default: { createServer: mockHttp.createServer },
  createServer: mockHttp.createServer,
}));

vi.mock("../../config.js", () => ({
  default: {
    port: 3001,
    ownerId: "111111111111111111",
    twinApiSecret: "test-twin-secret",
    botName: "irene-test",
  },
}));

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
}));

type MockRes = {
  statusCode: number | null;
  body: string;
  headers: Record<string, string>;
  setHeader: (key: string, value: string) => void;
  writeHead: (status: number) => void;
  end: (chunk?: string) => void;
};

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: "",
    headers: {},
    setHeader(key: string, value: string) {
      res.headers[key.toLowerCase()] = value;
    },
    writeHead(status: number) {
      res.statusCode = status;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
    },
  };
  return res;
}

async function call(path: string, ready: boolean, overrides: any = {}) {
  vi.resetModules();
  mockHttp.state.handler = null;
  mockHttp.createServer.mockClear();

  const { startPresenceAPI } = await import("../../presence.js");
  const client = {
    isReady: vi.fn(() => ready),
    ws: { status: ready ? 0 : 5 },
    user: { tag: ready ? "Irene#0001" : "connecting..." },
    ...overrides,
  };
  startPresenceAPI(client);
  expect(mockHttp.state.handler).toBeTypeOf("function");

  const req = {
    url: path,
    method: "GET",
    headers: {},
    socket: { remoteAddress: "203.0.113.10" },
  };
  const res = makeRes();
  await mockHttp.state.handler!(req, res);
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

describe("Irene presence HTTP probes", () => {
  it("keeps /healthz live while Discord is disconnected", async () => {
    const { status, body } = await call("/healthz", false);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.discord).toBe("disconnected");
  });

  it("marks /readyz unavailable while Discord is disconnected", async () => {
    const { status, body } = await call("/readyz", false);

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.discord).toBe("disconnected");
  });

  it("marks /readyz available once Discord is ready", async () => {
    const { status, body } = await call("/readyz", true);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.discord).toBe("ready");
  });

  it("treats ws status 0 plus a bot user as ready even if isReady lags", async () => {
    const { status, body } = await call("/readyz", false, {
      ws: { status: 0 },
      user: { tag: "Irene#0001" },
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.discord).toBe("ready");
  });
});
