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
  saveReminderCalls: [] as Array<{ userId: string; channelId: string; text: string; remindAt: string }>,
  saveNoteCalls: [] as Array<{ userId: string; title: string; content: string }>,
  saveFactCalls: [] as Array<{ userId: string; fact: string }>,
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
  saveReminder: async (userId: string, channelId: string, text: string, remindAt: string) => {
    dbState.saveReminderCalls.push({ userId, channelId, text, remindAt });
    return true;
  },
  saveNote: async (userId: string, title: string, content: string) => {
    dbState.saveNoteCalls.push({ userId, title, content });
    return true;
  },
  saveFact: async (userId: string, fact: string) => {
    dbState.saveFactCalls.push({ userId, fact });
    return true;
  },
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
  destroy: () => void;
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
  method = "POST",
  // Non-localhost (TEST-NET-3, RFC 5737) so requests never hit dashboard.js's
  // localhost auth-bypass — these tests exercise the REMOTE token gate. Distinct
  // per request keeps per-IP rate-limit buckets isolated. (127.0.0.x would
  // occasionally roll 127.0.0.1 and silently bypass auth → flaky 200 vs 401.)
  ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
}: {
  path: string;
  body: string;
  headers?: Record<string, string>;
  method?: string;
  ip?: string;
}): MockReq {
  const dataHandlers: Array<(chunk: string) => void> = [];
  const endHandlers: Array<() => void> = [];
  let destroyed = false;
  const req: MockReq = {
    url: path,
    method,
    headers,
    socket: { remoteAddress: ip },
    on(event: string, cb: any) {
      if (event === "data") dataHandlers.push(cb);
      if (event === "end") endHandlers.push(cb);
      return req;
    },
    // The handler calls req.destroy() when the body exceeds the ~1MB cap.
    // Mark the stream destroyed so we stop feeding it further chunks/end.
    destroy() { destroyed = true; },
  };
  // Flush body asynchronously so the handler's Promise that listens on the
  // stream actually subscribes before we emit. Microtask is enough.
  queueMicrotask(() => {
    if (body) for (const cb of dataHandlers) { if (destroyed) break; cb(body); }
    if (!destroyed) for (const cb of endHandlers) cb();
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
  process.env.TWIN_API_SECRET = SECRET;
  // Reset our in-memory db harness state.
  dbState.guildSettings = { cross_bot_punish: true };
  dbState.balance = { balance: 0 };
  dbState.updateBalanceCalls.length = 0;
  dbState.saveReminderCalls.length = 0;
  dbState.saveNoteCalls.length = 0;
  dbState.saveFactCalls.length = 0;
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

// State-changing legacy twin endpoints must fail closed unless HMAC-signed.
describe("/api/twin/remind, /api/twin/note, /api/twin/fact - strict HMAC auth", () => {
  const legacyEndpoints = [
    {
      path: "/api/twin/remind",
      payload: {
        user_id: "234567890123456789",
        channel_id: "345678901234567890",
        reminder_text: "drink water",
        remind_at: "2026-05-30T00:00:00.000Z",
      },
      calls: () => dbState.saveReminderCalls,
    },
    {
      path: "/api/twin/note",
      payload: {
        user_id: "234567890123456789",
        title: "note title",
        content: "note body",
      },
      calls: () => dbState.saveNoteCalls,
    },
    {
      path: "/api/twin/fact",
      payload: {
        user_id: "234567890123456789",
        fact: "likes regression tests",
      },
      calls: () => dbState.saveFactCalls,
    },
  ];

  it.each(legacyEndpoints)("fails closed for $path when TWIN_API_SECRET is missing", async ({ path, payload, calls }) => {
    delete process.env.TWIN_API_SECRET;
    const req = makeReq({
      path,
      body: JSON.stringify({ ...payload, secret: SECRET }),
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(500);
    expect(body.error).toMatch(/twin secret/i);
    expect(calls()).toHaveLength(0);
  });

  it.each(legacyEndpoints)("rejects $path with only legacy body.secret and no HMAC", async ({ path, payload, calls }) => {
    const req = makeReq({
      path,
      body: JSON.stringify({ ...payload, secret: SECRET }),
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(401);
    expect(body.error).toMatch(/twin auth/i);
    expect(calls()).toHaveLength(0);
  });

  it.each(legacyEndpoints)("accepts $path with a valid HMAC signature", async ({ path, payload, calls }) => {
    const bodyJson = JSON.stringify(payload);
    const headers = signTwinRequest(bodyJson, SECRET);
    const req = makeReq({ path, body: bodyJson, headers });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(calls()).toHaveLength(1);
  });
});

// Non-twin dashboard paths require an Authorization: Bearer <key> header where
// <key> is DASHBOARD_API_KEY or TWIN_API_SECRET, compared via safeStringEqual
// (constant-time). The legacy truncated-bot-token fallback was removed. These
// tests lock in the accept/reject behavior on a representative GET path.
describe("dashboard Bearer auth gate (/api/stats — non-twin)", () => {
  it("rejects a request with NO Authorization header with 401", async () => {
    const req = makeReq({ path: "/api/stats", body: "", method: "GET" });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
  });

  it("rejects a request with a WRONG Bearer token with 401", async () => {
    const req = makeReq({
      path: "/api/stats",
      body: "",
      method: "GET",
      headers: { authorization: "Bearer not-the-real-secret" },
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(401);
    expect(body.error).toMatch(/unauthorized/);
  });

  it("accepts a request whose Bearer token equals TWIN_API_SECRET with 200", async () => {
    // process.env.TWIN_API_SECRET is set to SECRET by tests/setup.ts and is one
    // of the validKeys safeStringEqual accepts.
    const req = makeReq({
      path: "/api/stats",
      body: "",
      method: "GET",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(200);
    expect(body.status).toBe("online");
  });
});

// ─── 413 payload-too-large cap ────────────────────────────────────────────────
// POST/PUT/PATCH bodies are capped at ~1MB; anything larger destroys the socket
// and returns 413 before reaching business logic. This mirrors the 10KB
// twin-command cap and protects against memory-exhaustion floods.
describe("dashboard body cap (413 payload too large)", () => {
  it("returns 413 and skips business logic for a body exceeding ~1MB", async () => {
    // /api/mood PATCH would normally call db.updateMood; an oversized body must
    // be rejected before that. Send 1MB + 1 byte so the > 1_048_576 cap trips.
    // This is a non-twin path, so it must clear the Bearer gate first; the cap
    // applies to authenticated callers too.
    const huge = "x".repeat(1_048_577);

    const req = makeReq({
      path: "/api/mood",
      body: huge,
      method: "PATCH",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const res = makeRes();
    const { status, body } = await call(req, res);

    expect(status).toBe(413);
    expect(body.error).toMatch(/payload too large/);
  });
});
