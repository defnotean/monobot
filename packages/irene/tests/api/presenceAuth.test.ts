import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { signTwinRequest, _resetReplayCacheForTests } from "@defnotean/shared/twinSign";

// ─── Endpoint-level auth tests for Irene's presence.js HTTP surface ─────────
// Mirrors the Eris pattern (tests/api/twinPunishAuth.test.ts +
// dashboardExposureAuth.test.ts): drive the REAL request handler captured from
// the mocked http.createServer with mock req/res from a non-localhost IP and
// assert that
//   (a) authenticated dashboard routes 401 WITHOUT the side effect firing,
//   (b) /api/twin/command rejects unsigned/tampered requests BEFORE executeTool,
//   (c) a validly-signed twin command passes auth (with aiInitiated:true),
//   (d) unauthenticated /health does NOT leak the owner Discord ID,
//   (e) twin endpoints use a DEDICATED rate-limit bucket — an unauthenticated
//       dashboard flood cannot 429 a signed twin command.

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

// Side-effect call records survive vi.resetModules() because they're hoisted.
const dbState = vi.hoisted(() => ({
  trustedUsers: [] as string[],
  addTrustedUserCalls: [] as Array<{ guildId: string; userId: string }>,
  removeTrustedUserCalls: [] as Array<{ guildId: string; userId: string }>,
  deleteConversationCalls: [] as string[],
  updatePersonalityCalls: [] as string[],
  saveConversationCalls: [] as string[],
}));

const executorState = vi.hoisted(() => ({
  executeToolCalls: [] as Array<{ toolName: string; args: any; opts: any }>,
}));

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
    botPersonality: "test",
    dashboardApiKey: "dashboard-key",
  },
}));

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("../../database.js", () => ({
  getTrustedUsers: () => dbState.trustedUsers,
  addTrustedUser: (guildId: string, userId: string) => {
    dbState.addTrustedUserCalls.push({ guildId, userId });
  },
  removeTrustedUser: (guildId: string, userId: string) => {
    dbState.removeTrustedUserCalls.push({ guildId, userId });
  },
  getMood: () => ({ mood_score: 0, energy: 50 }),
  moodLabel: () => "neutral",
  getConversationsData: () => ({}),
  deleteConversation: (id: string) => {
    dbState.deleteConversationCalls.push(id);
    return true;
  },
  getAllRelationships: () => [],
  getReminders: () => [],
  getPersonality: async () => null,
  updatePersonality: async (instructions: string) => {
    dbState.updatePersonalityCalls.push(instructions);
    return true;
  },
  saveConversation: (key: string) => {
    dbState.saveConversationCalls.push(key);
  },
}));

vi.mock("../../ai/memory.js", () => ({
  getMemoryData: () => ({}),
}));

vi.mock("../../ai/executor.js", () => ({
  executeTool: async (toolName: string, args: any, _message: any, opts: any) => {
    executorState.executeToolCalls.push({ toolName, args, opts });
    return "done";
  },
  // Pass-through: the mocked executeTool only returns strings, so the render
  // bridge is a no-op here. The real bridge is covered by confirmBridge.test.ts.
  postDeferralIfNeeded: async (result: any) => result,
}));

vi.mock("../../events/messageCreate.js", () => ({
  getConversations: () => new Map(),
  invalidatePersonalityCache: vi.fn(),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────
const SECRET = "test-twin-secret"; // must match the mocked config
const OWNER_ID = "111111111111111111";
const GUILD_ID = "222222222222222222";
const CHANNEL_ID = "333333333333333333";

// Non-localhost (TEST-NET-3, RFC 5737) so requests never hit the localhost
// auth-bypass — these tests exercise the REMOTE gates. Distinct per request
// keeps per-IP rate-limit buckets isolated.
function randomIp() {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

type MockReq = {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on: (event: string, cb: (...args: any[]) => void) => MockReq;
  destroy: () => void;
};

type MockRes = {
  statusCode: number | null;
  body: string;
  headers: Record<string, string>;
  setHeader: (key: string, value: string) => void;
  writeHead: (status: number) => void;
  end: (chunk?: string | Buffer) => void;
};

function makeReq({
  path,
  method = "GET",
  headers = {},
  body = "",
  ip = randomIp(),
}: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  ip?: string;
}): MockReq {
  const dataHandlers: Array<(chunk: string) => void> = [];
  const endHandlers: Array<() => void> = [];
  let destroyed = false;
  let flushed = false;
  // Flush only after the handler subscribes to "end" — presence.js awaits
  // dynamic imports BEFORE registering body listeners, so a fixed-delay flush
  // could fire while nobody is listening and the request would hang.
  const flush = () => {
    if (flushed) return;
    flushed = true;
    if (body) for (const cb of dataHandlers) { if (destroyed) break; cb(body); }
    if (!destroyed) for (const cb of endHandlers) cb();
  };
  const req: MockReq = {
    url: path,
    method,
    headers,
    socket: { remoteAddress: ip },
    on(event: string, cb: any) {
      if (event === "data") dataHandlers.push(cb);
      if (event === "end") {
        endHandlers.push(cb);
        queueMicrotask(flush);
      }
      return req;
    },
    destroy() { destroyed = true; },
  };
  return req;
}

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
    end(chunk?: string | Buffer) {
      if (chunk) res.body += String(chunk);
    },
  };
  return res;
}

function makeClient() {
  const channel = { id: CHANNEL_ID, send: vi.fn(async () => ({})) };
  const ownerMember = {
    id: OWNER_ID,
    displayName: "owner",
    nickname: null,
    user: { id: OWNER_ID, username: "owner", tag: "owner#0001", globalName: "owner" },
  };
  const guild = {
    id: GUILD_ID,
    name: "Test Guild",
    memberCount: 2,
    iconURL: () => null,
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    members: {
      cache: new Map([[OWNER_ID, ownerMember]]),
      fetch: vi.fn(async () => ownerMember),
    },
  };
  const client = {
    isReady: () => true,
    ws: { status: 0 },
    user: { tag: "Irene#0001" },
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
    users: { cache: new Map() },
  };
  return { client, guild, channel, ownerMember };
}

// Load a FRESH presence.js (fresh module-level rate-limit buckets) and return
// the captured request handler.
async function loadHandler() {
  vi.resetModules();
  mockHttp.state.handler = null;
  mockHttp.createServer.mockClear();
  delete process.env.RENDER_EXTERNAL_URL; // never start the self-ping interval
  process.env.DASHBOARD_API_KEY = "dashboard-key";

  // @ts-expect-error - importing JS module without types
  const { startPresenceAPI } = await import("../../presence.js");
  const { client } = makeClient();
  startPresenceAPI(client);
  expect(mockHttp.state.handler).toBeTypeOf("function");
  return mockHttp.state.handler!;
}

async function call(handler: (req: any, res: any) => unknown, req: MockReq) {
  const res = makeRes();
  await handler(req, res);
  // The twin-command route writes its response from inside the body "end"
  // listener (async, with awaited dynamic imports) — drain the loop until the
  // status lands.
  for (let i = 0; i < 50 && res.statusCode === null; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function signedTwinCommand(overrides: Record<string, unknown> = {}) {
  const payload = JSON.stringify({
    requester_id: OWNER_ID,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    command: "ban",
    args: { username: "target", reason: "spam" },
    nonce: `nonce-${Math.random()}`,
    ...overrides,
  });
  return { payload, headers: signTwinRequest(payload, SECRET) };
}

beforeEach(() => {
  _resetReplayCacheForTests();
  dbState.trustedUsers = [];
  dbState.addTrustedUserCalls.length = 0;
  dbState.removeTrustedUserCalls.length = 0;
  dbState.deleteConversationCalls.length = 0;
  dbState.updatePersonalityCalls.length = 0;
  dbState.saveConversationCalls.length = 0;
  executorState.executeToolCalls.length = 0;
});

// ─── (a) Authenticated dashboard routes fail closed without side effects ────
describe("dashboard Bearer auth gate (remote, non-twin)", () => {
  it("rejects GET /api/stats with NO Authorization header with 401", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({ path: "/api/stats" }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
  });

  it("rejects GET /api/stats with a WRONG Bearer token with 401", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: "/api/stats",
      headers: { authorization: "Bearer not-the-real-key" },
    }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
  });

  it("rejects a Bearer token that only equals TWIN_API_SECRET with 401", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: "/api/stats",
      headers: { authorization: `Bearer ${SECRET}` },
    }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
  });

  it("accepts GET /api/stats with the DASHBOARD_API_KEY Bearer token", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: "/api/stats",
      headers: { authorization: "Bearer dashboard-key" },
    }));

    expect(status).toBe(200);
    expect(body.status).toBe("online");
  });

  it("401s unauthenticated POST /api/trusted-users WITHOUT calling addTrustedUser", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: "/api/trusted-users",
      method: "POST",
      body: JSON.stringify({ guild_id: GUILD_ID, user_id: OWNER_ID }),
    }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
    expect(dbState.addTrustedUserCalls).toHaveLength(0);
  });

  it("401s unauthenticated DELETE /api/trusted-users WITHOUT calling removeTrustedUser", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: `/api/trusted-users?guild_id=${GUILD_ID}&user_id=${OWNER_ID}`,
      method: "DELETE",
    }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
    expect(dbState.removeTrustedUserCalls).toHaveLength(0);
  });

  it("401s unauthenticated DELETE /api/conversations/:id WITHOUT deleting anything", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: "/api/conversations/ch-12345",
      method: "DELETE",
    }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
    expect(dbState.deleteConversationCalls).toHaveLength(0);
  });

  it("401s unauthenticated PUT /api/personality WITHOUT writing the personality", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({
      path: "/api/personality",
      method: "PUT",
      body: JSON.stringify({ instructions: "be evil" }),
    }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
    expect(dbState.updatePersonalityCalls).toHaveLength(0);
  });

  it("401s unauthenticated GET /api/memories (PII memory facts)", async () => {
    const handler = await loadHandler();
    const { status, body } = await call(handler, makeReq({ path: "/api/memories" }));

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
  });
});

// ─── (b) + (c) /api/twin/command HMAC gate ───────────────────────────────────
describe("/api/twin/command — strict HMAC auth", () => {
  it("rejects an UNSIGNED request with 403 BEFORE executeTool runs", async () => {
    const handler = await loadHandler();
    const { payload } = signedTwinCommand();
    const { status, body } = await call(handler, makeReq({
      path: "/api/twin/command",
      method: "POST",
      body: payload, // valid body, but no HMAC headers
    }));

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/twin auth failed/);
    expect(executorState.executeToolCalls).toHaveLength(0);
  });

  it("rejects a TAMPERED-signature request with 403 BEFORE executeTool runs", async () => {
    const handler = await loadHandler();
    // Sign one body, then send a different body with the same headers.
    const { headers } = signedTwinCommand();
    const tamperedBody = JSON.stringify({
      requester_id: OWNER_ID,
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      command: "ban",
      args: { username: "someone-else", reason: "TAMPERED" },
    });
    const { status, body } = await call(handler, makeReq({
      path: "/api/twin/command",
      method: "POST",
      body: tamperedBody,
      headers,
    }));

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/twin auth failed/);
    expect(executorState.executeToolCalls).toHaveLength(0);
  });

  it("accepts a VALIDLY-SIGNED command and executes it with aiInitiated:true", async () => {
    const handler = await loadHandler();
    const { payload, headers } = signedTwinCommand();
    const { status, body } = await call(handler, makeReq({
      path: "/api/twin/command",
      method: "POST",
      body: payload,
      headers,
    }));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result).toBe("done");
    expect(executorState.executeToolCalls).toHaveLength(1);
    expect(executorState.executeToolCalls[0].toolName).toBe("ban_user"); // alias resolved
    expect(executorState.executeToolCalls[0].args).toMatchObject({ username: "target" });
    // Regression: the relay must engage the human-confirm deferral exactly like
    // the AI tool loop does — a relayed ban is AI-initiated on Eris's side.
    expect(executorState.executeToolCalls[0].opts).toMatchObject({ aiInitiated: true });
  });

  it("rejects a signed command OUTSIDE the relay allowlist with 403, without executeTool", async () => {
    const handler = await loadHandler();
    const { payload, headers } = signedTwinCommand({ command: "set_server_persona" });
    const { status, body } = await call(handler, makeReq({
      path: "/api/twin/command",
      method: "POST",
      body: payload,
      headers,
    }));

    expect(status).toBe(403);
    expect(body.error).toMatch(/not permitted/);
    expect(executorState.executeToolCalls).toHaveLength(0);
  });
});

// ─── (d) /health must not leak the owner Discord ID ─────────────────────────
describe("/health (unauthenticated)", () => {
  it("responds 200 WITHOUT the owner Discord ID", async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ path: "/health" }), res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(body.user).toBeUndefined();
    expect(res.body).not.toContain(OWNER_ID);
  });
});

// ─── (e) twin limiter isolation ──────────────────────────────────────────────
describe("twin rate-limit bucket isolation", () => {
  it("an unauthenticated dashboard flood does NOT 429 a signed twin command", async () => {
    const handler = await loadHandler();
    const floodIp = "198.51.100.7"; // fixed so the flood hits ONE per-IP bucket

    // Exhaust the dashboard bucket (180/min/IP) from this IP via the public,
    // unauthenticated /api/health endpoint.
    let saw429 = false;
    for (let i = 0; i < 181; i++) {
      const { status } = await call(handler, makeReq({ path: "/api/health", ip: floodIp }));
      if (status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true); // the shared dashboard bucket really is exhausted

    // A signed twin command from the SAME IP must still go through — it lives
    // in the dedicated twin bucket, not the flooded dashboard bucket.
    const { payload, headers } = signedTwinCommand();
    const { status, body } = await call(handler, makeReq({
      path: "/api/twin/command",
      method: "POST",
      body: payload,
      headers,
      ip: floodIp,
    }));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(executorState.executeToolCalls).toHaveLength(1);
  });

  it("still enforces a per-IP limit ON the twin endpoints themselves", async () => {
    const handler = await loadHandler();
    const ip = "198.51.100.42";

    // 60/min/IP on the twin bucket: hammer unsigned requests (each consumes
    // budget and 403s) until the 61st request 429s instead.
    let last: { status: number | null } = { status: null };
    for (let i = 0; i < 61; i++) {
      last = await call(handler, makeReq({ path: "/api/twin/command", method: "POST", body: "{}", ip }));
      if (i < 60) expect(last.status).toBe(403);
    }
    expect(last.status).toBe(429);
    expect(executorState.executeToolCalls).toHaveLength(0);
  });
});
