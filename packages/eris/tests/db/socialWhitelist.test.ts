import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported so the persisted social helpers
// (whitelist, analytics, dashboard, getAllRelationships) run against the mock
// client. Mood + in-memory relationship helpers are pure-cache.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// ─── bot_data:main blob backing the unified whitelist ───────────────────────
let botDataMain: { id: string; data: any } | null = null;
// Toggle: when false, the whitelist RPCs are "unavailable" so the code falls
// back to the read-modify-write path. When true, the RPC succeeds atomically.
let rpcAvailable = true;
let rpcCalls: Array<{ name: string; args: any }> = [];
// Drive the select-error branch in the fallback path.
let botDataSelectError: { code: string; message: string } | null = null;
let botDataUpsertError: { code: string; message: string } | null = null;

// Persisted relationships rows (Supabase baseline for getAllRelationships).
let relRows: Array<{ user_id: string; affinity_score: number; interactions_count: number }> = [];

// Analytics insert sink + dashboard fixtures.
let analyticsRows: Array<{ tool_name: string; user_id: string; channel_id: string; created_at: string }> = [];
let memoryRows: Array<{ user_id: string; channel_id: string; is_bot: boolean }> = [];

function botDataChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(_col: string, val: any) {
          return {
            async single() {
              if (val !== "main") return { data: null, error: null };
              if (botDataSelectError) return { data: null, error: botDataSelectError };
              return { data: botDataMain ? { data: botDataMain.data } : null, error: botDataMain ? null : { code: "PGRST116", message: "no rows" } };
            },
          };
        },
      };
    },
    async upsert(row: any) {
      if (botDataUpsertError) return { error: botDataUpsertError };
      botDataMain = { id: row.id, data: row.data };
      return { error: null };
    },
  };
}

function relChain() {
  return {
    select(_cols: string = "*") {
      return {
        order(_col: string, _opts: any) {
          return { then: (resolve: any) => resolve({ data: relRows.map(r => ({ ...r })), error: null }) };
        },
      };
    },
    upsert(_rows: any) { return Promise.resolve({ error: null }); },
  };
}

function analyticsChain() {
  return {
    insert(row: any) {
      analyticsRows.push({ tool_name: row.tool_name, user_id: row.user_id, channel_id: row.channel_id, created_at: new Date().toISOString() });
      return Promise.resolve({ data: null, error: null });
    },
    select(_cols: string = "*", opts?: any) {
      // getAnalytics: .select("*").gte("created_at", since).order(...)
      // getDashboardStats: .select("*", { count: "exact", head: true })
      if (opts?.head) {
        return Promise.resolve({ count: analyticsRows.length, error: null });
      }
      return {
        gte(_c: string, _v: any) {
          return { order: (_o: string, _opt: any) => ({ then: (resolve: any) => resolve({ data: analyticsRows.map(r => ({ ...r })), error: null }) }) };
        },
      };
    },
  };
}

function memoryChain() {
  return {
    select(_cols: string = "*", opts?: any) {
      if (opts?.head) return Promise.resolve({ count: memoryRows.length, error: null });
      return {
        // getDashboardStats: .select("user_id").eq("is_bot", false)
        eq(_col: string, val: any) {
          const rows = memoryRows.filter(m => m.is_bot === val).map(m => ({ user_id: m.user_id }));
          return { then: (resolve: any) => resolve({ data: rows, error: null }) };
        },
        // .select("channel_id") awaited directly
        then: (resolve: any) => resolve({ data: memoryRows.map(m => ({ channel_id: m.channel_id })), error: null }),
      };
    },
  };
}

function makeNoopChain(): any {
  const chain: any = {};
  for (const m of ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or", "order", "limit", "insert", "upsert", "update", "delete", "from"]) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "bot_data") return botDataChain();
      if (table === "eris_relationships") return relChain();
      if (table === "eris_analytics") return analyticsChain();
      if (table === "eris_memories") return memoryChain();
      return makeNoopChain();
    },
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (rpcAvailable) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

let db: any;

beforeEach(async () => {
  botDataMain = null;
  rpcAvailable = true;
  rpcCalls = [];
  botDataSelectError = null;
  botDataUpsertError = null;
  relRows = [];
  analyticsRows = [];
  memoryRows = [];
  vi.resetModules();
  db = await import("../../database.js");
  await db.initDatabase();
});

describe("social.js — mood (in-memory, clamped)", () => {
  it("updateMood clamps mood to [-100,100] and energy to [0,100]", () => {
    db.updateMood(500, 500);
    expect(db.getMood()).toEqual({ mood_score: 100, energy: 100 });
    db.updateMood(-500, -500);
    expect(db.getMood()).toEqual({ mood_score: -100, energy: 0 });
  });

  it("shiftMood applies a relative delta on top of current state", () => {
    db.updateMood(0, 50);
    db.shiftMood(30, -10);
    expect(db.getMood()).toEqual({ mood_score: 30, energy: 40 });
  });

  it("getMood returns a copy, not the live object", () => {
    const a = db.getMood();
    a.mood_score = 999;
    expect(db.getMood().mood_score).not.toBe(999);
  });
});

describe("social.js — relationships (in-memory)", () => {
  it("getRelationship returns a zeroed default for an unknown user", () => {
    expect(db.getRelationship("nobody")).toEqual({ affinity_score: 0, interactions_count: 0 });
  });

  it("updateRelationship accumulates interactions and clamps affinity", () => {
    db.updateRelationship("u1", 30);
    db.updateRelationship("u1", 80); // 30+80 = 110 → clamp 100
    const r = db.getRelationship("u1");
    expect(r.affinity_score).toBe(100);
    expect(r.interactions_count).toBe(2);
  });

  it("affinity floor clamps at -100", () => {
    db.updateRelationship("u2", -60);
    db.updateRelationship("u2", -60);
    expect(db.getRelationship("u2").affinity_score).toBe(-100);
  });

  it("getAllRelationships merges in-memory over persisted and sorts desc", async () => {
    relRows = [
      { user_id: "persisted-only", affinity_score: 10, interactions_count: 4 },
      { user_id: "u3", affinity_score: 5, interactions_count: 1 },
    ];
    db.updateRelationship("u3", 50); // in-memory fresher → 50, overrides the persisted 5
    const all = await db.getAllRelationships();
    const u3 = all.find((r: any) => r.user_id === "u3");
    expect(u3.affinity_score).toBe(50);
    // Sorted descending by affinity_score.
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].affinity_score).toBeGreaterThanOrEqual(all[i].affinity_score);
    }
  });
});

describe("social.js — analytics & dashboard", () => {
  it("logToolUsage inserts a row that getAnalytics returns", async () => {
    await db.logToolUsage("roll_dice", "u4", "chan");
    const rows = await db.getAnalytics(7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: "roll_dice", user_id: "u4", channel_id: "chan" });
  });

  it("getDashboardStats aggregates unique users/channels and counts", async () => {
    memoryRows = [
      { user_id: "a", channel_id: "c1", is_bot: false },
      { user_id: "a", channel_id: "c2", is_bot: false }, // same user, new channel
      { user_id: "b", channel_id: "c1", is_bot: false },
    ];
    analyticsRows = [
      { tool_name: "t", user_id: "a", channel_id: "c1", created_at: "" },
    ];
    const stats = await db.getDashboardStats();
    expect(stats.messages).toBe(3);
    expect(stats.users).toBe(2); // a, b
    expect(stats.channels).toBe(2); // c1, c2
    expect(stats.commands).toBe(1);
  });
});

describe("social.js — unified whitelist (RPC path)", () => {
  it("getWhitelist returns {} when no bot_data row exists (PGRST116)", async () => {
    expect(await db.getWhitelist()).toEqual({});
  });

  it("addToWhitelist uses the atomic RPC when available", async () => {
    const ok = await db.addToWhitelist("g-1", { name: "Cool Server", members: 42, invited_by: "owner" });
    expect(ok).toBe(true);
    expect(rpcCalls.some(c => c.name === "bot_whitelist_add" && c.args.p_guild_id === "g-1")).toBe(true);
    // RPC path does NOT do a read-modify-write upsert.
    expect(botDataMain).toBeNull();
  });

  it("removeFromWhitelist uses the atomic RPC when available", async () => {
    const ok = await db.removeFromWhitelist("g-2");
    expect(ok).toBe(true);
    expect(rpcCalls.some(c => c.name === "bot_whitelist_remove" && c.args.p_guild_id === "g-2")).toBe(true);
  });
});

describe("social.js — unified whitelist (read-modify-write fallback)", () => {
  beforeEach(() => { rpcAvailable = false; });

  it("addToWhitelist falls back to upserting the merged blob and isWhitelisted sees it", async () => {
    const ok = await db.addToWhitelist("g-fb", { name: "Fallback Server" });
    expect(ok).toBe(true);
    expect(botDataMain?.data.server_whitelist["g-fb"]).toMatchObject({ name: "Fallback Server" });
    expect(await db.isWhitelisted("g-fb")).toBe(true);
    expect(await db.isWhitelisted("not-listed")).toBe(false);
  });

  it("addToWhitelist defaults missing info fields", async () => {
    await db.addToWhitelist("g-defaults", {});
    const entry = botDataMain?.data.server_whitelist["g-defaults"];
    expect(entry.name).toBe("Unknown");
    expect(entry.icon_url).toBeNull();
    expect(entry.members).toBeNull();
    expect(typeof entry.added_at).toBe("string");
  });

  it("addToWhitelist returns false when the fallback select errors (non-PGRST116)", async () => {
    botDataSelectError = { code: "XX000", message: "db down" };
    expect(await db.addToWhitelist("g-err", { name: "x" })).toBe(false);
  });

  it("addToWhitelist returns false when the fallback upsert errors", async () => {
    botDataUpsertError = { code: "XX000", message: "write failed" };
    expect(await db.addToWhitelist("g-upfail", { name: "x" })).toBe(false);
  });

  it("removeFromWhitelist deletes the key via fallback and persists", async () => {
    // Seed an existing whitelist with two entries.
    botDataMain = { id: "main", data: { server_whitelist: { keep: { name: "keep" }, drop: { name: "drop" } } } };
    const ok = await db.removeFromWhitelist("drop");
    expect(ok).toBe(true);
    expect(botDataMain.data.server_whitelist).toHaveProperty("keep");
    expect(botDataMain.data.server_whitelist).not.toHaveProperty("drop");
  });

  it("removeFromWhitelist is a no-op success when the guild was not whitelisted", async () => {
    botDataMain = { id: "main", data: { server_whitelist: { keep: { name: "keep" } } } };
    const before = JSON.stringify(botDataMain.data);
    const ok = await db.removeFromWhitelist("never-there");
    expect(ok).toBe(true);
    expect(JSON.stringify(botDataMain.data)).toBe(before);
  });

  it("removeFromWhitelist returns false when the fallback upsert errors", async () => {
    botDataMain = { id: "main", data: { server_whitelist: { drop: { name: "drop" } } } };
    botDataUpsertError = { code: "XX000", message: "write failed" };
    expect(await db.removeFromWhitelist("drop")).toBe(false);
  });
});

describe("social.js — price/news/deploy watches & dreams", () => {
  it("addNewsWatch / getNewsWatches / removeNewsWatch round-trip", async () => {
    // These use the generic noop chain for non-modeled tables; assert the
    // boolean contract (insert ok → true, delete ok → true).
    expect(await db.addNewsWatch("u", "c", "ai news")).toBe(true);
    expect(Array.isArray(await db.getNewsWatches())).toBe(true);
    expect(await db.removeNewsWatch("u", 1)).toBe(true);
  });

  it("addDeployWatch returns true and getDeployWatches returns an array", async () => {
    expect(await db.addDeployWatch("vercel", "proj-1", "chan")).toBe(true);
    expect(Array.isArray(await db.getDeployWatches())).toBe(true);
  });

  it("getRecentDreams clamps the limit and returns an array", async () => {
    expect(Array.isArray(await db.getRecentDreams(99))).toBe(true);
    await expect(db.saveDream("a quiet dream", { mood: "calm" })).resolves.toBeUndefined();
  });
});
