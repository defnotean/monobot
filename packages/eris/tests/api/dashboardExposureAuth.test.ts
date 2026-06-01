import { beforeEach, describe, expect, it, vi } from "vitest";

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
    close: vi.fn(),
  };
  const createServer = vi.fn((handler: (req: any, res: any) => unknown) => {
    state.handler = handler;
    return server;
  });
  const request = vi.fn((_url: string, _options: any, cb: (upstreamRes: any) => void) => {
    const upstreamRes = {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      pipe: (res: any) => res.end(JSON.stringify({ proxied: true })),
    };
    queueMicrotask(() => cb(upstreamRes));
    return {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
  });
  return { state, server, createServer, request };
});

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "first\nsecond\nthird\n"),
  readdirSync: vi.fn(() => []),
}));

const mockDiscordState = vi.hoisted(() => ({
  ready: true,
}));

vi.mock("http", () => ({
  default: {
    createServer: mockHttp.createServer,
    request: mockHttp.request,
  },
  createServer: mockHttp.createServer,
  request: mockHttp.request,
}));

vi.mock("fs", () => mockFs);

vi.mock("discord.js", () => ({
  Client: vi.fn(function Client() {
    return {
    commands: null,
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn(async () => "logged-in"),
    destroy: vi.fn(),
    isReady: vi.fn(() => mockDiscordState.ready),
    ws: { status: 0 },
    };
  }),
  Collection: class Collection<K, V> extends Map<K, V> {},
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMembers: 8,
    DirectMessages: 16,
    GuildPresences: 32,
    GuildMessageReactions: 64,
  },
  Partials: {
    Message: 1,
    Channel: 2,
    User: 3,
    Reaction: 4,
  },
}));

vi.mock("../../database.js", () => ({
  initDatabase: vi.fn(async () => undefined),
  flushAll: vi.fn(async () => undefined),
  isPersistenceHealthy: vi.fn(() => true),
}));

vi.mock("../../config.js", () => ({
  default: {
    port: 3000,
    token: "test-token",
    botName: "eris-test",
    botPersonality: "test",
    ownerId: "111111111111111111",
    twinApiSecret: "test-twin-secret",
    twinApiUrl: "https://irene.test",
  },
}));

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("../../utils/autoDeploy.js", () => ({
  maybeAutoDeploy: vi.fn(async () => undefined),
}));

vi.mock("@defnotean/shared/alert", () => ({
  sendAlert: vi.fn(),
}));

type MockReq = {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on: (event: string, cb: (...args: any[]) => void) => MockReq;
};

type MockRes = {
  statusCode: number | null;
  body: string;
  headers: Record<string, string>;
  setHeader: (key: string, value: string) => void;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (chunk?: string) => void;
};

function makeReq(url: string, headers: Record<string, string> = {}): MockReq {
  return {
    url,
    method: "GET",
    headers,
    socket: { remoteAddress: "203.0.113.77" },
    on: vi.fn(function on(this: MockReq) {
      return this;
    }),
  };
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: "",
    headers: {},
    setHeader(key: string, value: string) {
      res.headers[key.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      for (const [key, value] of Object.entries(headers || {})) {
        res.headers[key.toLowerCase()] = value;
      }
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
    },
  };
  return res;
}

async function loadHandler() {
  vi.resetModules();
  mockHttp.state.handler = null;
  mockHttp.createServer.mockClear();
  mockHttp.request.mockClear();
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue("first\nsecond\nthird\n");
  mockFs.readFileSync.mockClear();
  mockFs.readdirSync.mockReturnValue([]);
  mockFs.readdirSync.mockClear();
  process.env.DASHBOARD_API_KEY = "dashboard-key";
  process.env.TWIN_API_SECRET = "test-twin-secret";

  await import("../../index.js");
  expect(mockHttp.state.handler).toBeTypeOf("function");
  return mockHttp.state.handler!;
}

async function call(url: string, headers: Record<string, string> = {}) {
  const handler = await loadHandler();
  const res = makeRes();
  await handler(makeReq(url, headers), res);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Eris early dashboard HTTP routes", () => {
  it("keeps /healthz live while Discord is disconnected", async () => {
    mockDiscordState.ready = false;

    const { status, body } = await call("/healthz");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.discord).toBe("disconnected");
  });

  it("marks /readyz unavailable while Discord is disconnected", async () => {
    mockDiscordState.ready = false;

    const { status, body } = await call("/readyz");

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.discord).toBe("disconnected");
  });

  it("rejects unauthenticated remote /api/irene requests before proxying to Irene", async () => {
    const { status, body } = await call("/api/irene/health");

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
    expect(mockHttp.request).not.toHaveBeenCalled();
  });

  it("allows authenticated remote /api/irene requests to reach the proxy", async () => {
    const { status, body } = await call("/api/irene/health", {
      authorization: "Bearer dashboard-key",
    });

    expect(status).toBe(200);
    expect(body.proxied).toBe(true);
    expect(mockHttp.request).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated remote /api/logs requests before reading log files", async () => {
    const { status, body } = await call("/api/logs?bot=eris&lines=10");

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it("allows authenticated remote /api/logs requests to read the requested tail", async () => {
    const { status, body } = await call("/api/logs?bot=eris&lines=10", {
      authorization: "Bearer dashboard-key",
    });

    expect(status).toBe(200);
    expect(body.bot).toBe("eris");
    expect(body.tail).toContain("third");
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });
});
