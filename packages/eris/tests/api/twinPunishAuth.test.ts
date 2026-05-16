import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { signTwinRequest, _resetReplayCacheForTests } from "@defnotean/shared/twinSign";

// ─── Mocks ──────────────────────────────────────────────────────────────────
// dashboard.js pulls in database.js, config.js, and the logger. We replace
// each so importing the handler has no side effects beyond what we control.
//
// The goal of this suite is narrow: prove that /api/twin/punish accepts
// HMAC-signed requests and rejects unsigned or tampered requests with 401 —
// the legacy `body.secret` bearer fallback has been removed.

const dbState = {
  guildSettings: { cross_bot_punish: true } as Record<string, unknown>,
  balance: { balance: 0 } as { balance: number },
  updateBalanceCalls: [] as Array<{ userId: string; delta: number; type: string; details: string }>,
};

vi.mock("../../database.js", () => ({
  getSupabase: () => null,
  getDashboardStats: async () => ({}),
  getMood: () => ({ mood_score: 0, energy: 50 }),
  getPersonality: async () => null,
  updateMood: vi.fn(),
  getRelationship: () => ({ affinity_score: 0, interactions_count: 0 }),
  updateRelationship: vi.fn(),
  getAllRelationships: async () => [],
  getFacts: async () => [],
  deleteFact: async () => true,
  getRecentHistory: async () => [],
  saveReminder: async () => true,
  saveNote: async () => true,
  saveFact: async () => true,
  getNotes: async () => [],
  getUserReminders: async () => [],
  updatePersonality: async () => true,
  getAnalytics: async () => [],
  getGuildSettings: (gid: string) => ({ guild_id: gid, ...dbState.guildSettings }),
  getBalance: async () => dbState.balance,
  updateBalance: async (userId: string, delta: number, type: string, details: string) => {
    dbState.updateBalanceCalls.push({ userId, delta, type, details });
    return true;
  },
}));

vi.mock("../../config.js", () => ({
  default: {
    port: 3000,
    botName: "eris-test",
    botPersonality: "test",
    ownerId: "111111111111111111",
    twinApiSecret: "test-twin-secret",
    twinApiUrl: "https://twin.test",
  },
}));

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import { handleApiRequest } from "../../api/dashboard.js";

// ─── Test harness ───────────────────────────────────────────────────────────
// Build a minimal Node-style req/res pair the handler can drive. The handler
// reads the body via a `data`/`end` event stream and writes the response via
// `writeHead` + `end`, so we emulate exactly that surface.

type MockReq = {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on: (event: string, cb: (chunk: string) => void) => MockReq;
};

type MockRes = {
  statusCode: number | null;
  body: string;
  headers: Record<string, string>;
  setHeader: (k: string, v: string) => void;
  writeHead: (code: number) => void;
  end: (chunk?: string) => void;
};

function makeReq({
  path,
  body,
  headers = {},
  ip = `127.0.0.${Math.floor(Math.random() * 200) + 1}`,
}: {
  path: string;
  body: string;
  headers?: Record<string, string>;
  ip?: string;
}): MockReq {
  const dataHandlers: Array<(chunk: string) => void> = [];
  const endHandlers: Array<() => void> = [];
  const req: MockReq = {
    url: path,
    method: "POST",
    headers,
    socket: { remoteAddress: ip },
    on(event: string, cb: any) {
      if (event === "data") dataHandlers.push(cb);
      if (event === "end") endHandlers.push(cb);
      return req;
    },
  };
  // Flush body asynchronously so the handler's Promise that listens on the
  // stream actually subscribes before we emit. Microtask is enough.
  queueMicrotask(() => {
    if (body) for (const cb of dataHandlers) cb(body);
    for (const cb of endHandlers) cb();
  });
  return req;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: "",
    headers: {},
    setHeader(k: string, v: string) { res.headers[k.toLowerCase()] = v; },
    writeHead(code: number) { res.statusCode = code; },
    end(chunk?: string) { if (chunk) res.body = chunk; },
  };
  return res;
}

async function call(req: MockReq, res: MockRes) {
  await handleApiRequest(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
const SECRET = "test-twin-secret"; // must match the mocked config + setup.ts

const validBodyJson = JSON.stringify({
  guild_id: "123456789012345678",
  user_id: "234567890123456789",
  action: "ban",
  reason: "spam",
  nonce: "fixed-nonce-for-tests",
});

beforeEach(() => {
  _resetReplayCacheForTests();
  // Reset our in-memory db harness state.
  dbState.guildSettings = { cross_bot_punish: true };
  dbState.balance = { balance: 0 };
  dbState.updateBalanceCalls.length = 0;
  // Wipe the per-process dashboard rate-limit map between tests so a flood of
  // requests from the same IP doesn't trip the 30/min/IP guard in dashboard.js.
  if ((globalThis as any)._dashRateLimits) (globalThis as any)._dashRateLimits.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("/api/twin/punish — strict HMAC auth (legacy body.secret removed)", () => {
  it("rejects an UNSIGNED request with 401 (no body.secret fallback)", async () => {
    // No HMAC headers, no body.secret. Previously this could have been
    // accepted if `body.secret === TWIN_API_SECRET`; that path is gone.
    const bodyWithLegacySecret = JSON.stringify({
      guild_id: "123456789012345678",
      user_id: "234567890123456789",
      action: "ban",
      secret: SECRET, // legacy bearer — must NO LONGER be accepted
    });

    const req = makeReq({ path: "/api/twin/punish", body: bodyWithLegacySecret });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(401);
    expect(body.error).toMatch(/twin auth/);
    // And no balance write should have happened — the request never reached
    // the business logic.
    expect(dbState.updateBalanceCalls).toHaveLength(0);
  });

  it("rejects a TAMPERED-signature request with 401", async () => {
    // Sign one body, then send a different body with the same signature
    // headers. verifyTwinRequest must reject this as "bad signature".
    const headers = signTwinRequest(validBodyJson, SECRET);
    const tamperedBody = JSON.stringify({
      guild_id: "123456789012345678",
      user_id: "234567890123456789",
      action: "ban",
      reason: "TAMPERED extra field",
      nonce: "fixed-nonce-for-tests",
    });

    const req = makeReq({
      path: "/api/twin/punish",
      body: tamperedBody,
      headers,
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(401);
    expect(body.error).toMatch(/twin auth/);
    expect(dbState.updateBalanceCalls).toHaveLength(0);
  });

  it("accepts a VALID HMAC-signed request with 200 and applies the punish", async () => {
    dbState.balance = { balance: 500 };
    const headers = signTwinRequest(validBodyJson, SECRET);

    const req = makeReq({
      path: "/api/twin/punish",
      body: validBodyJson,
      headers,
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(200);
    expect(body.applied).toBe(true);
    expect(body.action).toBe("ban");
    expect(body.confiscated).toBe(500);
    expect(dbState.updateBalanceCalls).toHaveLength(1);
    expect(dbState.updateBalanceCalls[0]).toMatchObject({
      userId: "234567890123456789",
      delta: -500,
      type: "irene_ban",
    });
  });

  it("rejects a request whose body.secret matches TWIN_API_SECRET but lacks HMAC headers (regression for the legacy fallback)", async () => {
    // This is the exact attack the legacy fallback enabled: a single bearer
    // value, replayable forever, with no per-request signature binding. The
    // fix removes the fallback so even a "correct" body.secret is meaningless
    // without the HMAC headers.
    const legacyBody = JSON.stringify({
      guild_id: "123456789012345678",
      user_id: "234567890123456789",
      action: "ban",
      secret: SECRET,
    });

    const req = makeReq({ path: "/api/twin/punish", body: legacyBody });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(401);
    expect(body.error).toMatch(/twin auth/);
  });
});
