import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Regression: Irene shares ONE whitelist with Eris ─────────────────────────
//
// Before the unify-whitelist change, Irene kept its own server_whitelist copy in
// the bot_data row id="irene" and read it from the in-memory cache synchronously.
// Eris meanwhile used the canonical bot_data row id="main" (data.server_whitelist)
// mutated via the bot_whitelist_add/remove RPCs. The two silently drifted.
//
// These tests prove Irene now reads/writes the SAME canonical row as Eris:
//   - an entry present in bot_data:main is seen by isWhitelisted / getWhitelist
//   - addToWhitelist writes to bot_data:main via the bot_whitelist_add RPC
//   - removeFromWhitelist deletes from bot_data:main via bot_whitelist_remove
//   - Irene never touches its own id="irene" row for the whitelist anymore
//
// We model a fake Supabase backing the bot_data:main row plus the two RPCs and
// inject it through the database._internal test hook (same pattern as
// dirtyFlush.test.ts), so no live DB is needed.

// ─── Fake Supabase ────────────────────────────────────────────────────────────
// Backing store: bot_data rows keyed by id, each with a `data` jsonb blob.
const botDataRows = new Map<string, any>();
const rpcCalls: { fn: string; args: any }[] = [];
const upsertCalls: { id: string; data: any }[] = [];
// When set, the RPCs report "unavailable" so we exercise the read-modify-write
// fallback path (mirrors Eris's pre-migration-007 fallback).
let rpcAvailable = true;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function fakeSupabase() {
  return {
    rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args: clone(args) });
      if (!rpcAvailable) {
        return Promise.resolve({ error: { message: "Could not find the function", code: "PGRST202" } });
      }
      if (fn === "bot_whitelist_add") {
        const row = botDataRows.get("main") ?? { id: "main", data: {} };
        if (!row.data.server_whitelist) row.data.server_whitelist = {};
        row.data.server_whitelist[args.p_guild_id] = clone(args.p_info);
        botDataRows.set("main", row);
        return Promise.resolve({ error: null });
      }
      if (fn === "bot_whitelist_remove") {
        const row = botDataRows.get("main");
        if (row?.data?.server_whitelist) delete row.data.server_whitelist[args.p_guild_id];
        return Promise.resolve({ error: null });
      }
      return Promise.resolve({ error: { message: `unexpected rpc ${fn}` } });
    },
    from(table: string) {
      if (table !== "bot_data") throw new Error(`fakeSupabase: unexpected table "${table}"`);
      let _id: string | null = null;
      const builder: any = {
        select() { return builder; },
        eq(_col: string, val: string) { _id = val; return builder; },
        single() {
          const row = _id != null ? botDataRows.get(_id) : null;
          if (!row) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } });
          return Promise.resolve({ data: { data: clone(row.data) }, error: null });
        },
        upsert(payload: { id: string; data: any }) {
          upsertCalls.push({ id: payload.id, data: clone(payload.data) });
          botDataRows.set(payload.id, { id: payload.id, data: clone(payload.data) });
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
}

// ─── Mocks — config + logger ──────────────────────────────────────────────────
vi.mock("../../config.js", () => ({
  default: {
    get dualWritePersistence() { return false; },
    botName: "irene-test",
    supabaseEnabled: true,
  },
}));

vi.mock("../../utils/logger.js", () => ({ log: () => {} }));

import * as db from "../../database.js";

// ─── Lifecycle ─────────────────────────────────────────────────────────────────
beforeEach(() => {
  botDataRows.clear();
  rpcCalls.length = 0;
  upsertCalls.length = 0;
  rpcAvailable = true;
  db._internal.__resetForTest();
  db._internal.__setSupabaseForTest(fakeSupabase());
});

afterEach(() => {
  db._internal.__resetForTest();
});

// ─── Tests ───────────────────────────────────────────────────────────────────
describe("unified whitelist — Irene reads/writes the canonical bot_data:main row", () => {
  it("isWhitelisted sees an entry present in bot_data:main (shared with Eris)", async () => {
    // Simulate Eris (or any writer) having put a server in the canonical row.
    botDataRows.set("main", { id: "main", data: { server_whitelist: { "guild-eris": { name: "Eris Server" } } } });

    expect(await db.isWhitelisted("guild-eris")).toBe(true);
    expect(await db.isWhitelisted("guild-unknown")).toBe(false);
  });

  it("getWhitelist returns the canonical bot_data:main map, not Irene's own blob", async () => {
    botDataRows.set("main", { id: "main", data: { server_whitelist: { "g1": { name: "A" }, "g2": { name: "B" } } } });
    // Poison the (now-dead) id="irene" row to prove it is NOT consulted.
    botDataRows.set("irene", { id: "irene", data: { server_whitelist: { "g-stale": { name: "STALE" } } } });

    const wl = await db.getWhitelist();
    expect(Object.keys(wl).sort()).toEqual(["g1", "g2"]);
    expect(wl["g-stale"]).toBeUndefined();
  });

  it("addToWhitelist writes to bot_data:main via the bot_whitelist_add RPC", async () => {
    const ok = await db.addToWhitelist("g-new", { name: "New Server", invited_by: "owner-1" });
    expect(ok).toBe(true);

    // The atomic RPC was used (preferred path), targeting the canonical row.
    expect(rpcCalls.some((c) => c.fn === "bot_whitelist_add" && c.args.p_guild_id === "g-new")).toBe(true);

    // The write landed in bot_data:main and is visible through the shared read.
    expect(botDataRows.get("main").data.server_whitelist["g-new"]).toMatchObject({
      name: "New Server",
      invited_by: "owner-1",
    });
    expect(await db.isWhitelisted("g-new")).toBe(true);

    // Irene's own id="irene" row was never created/touched for the whitelist.
    expect(botDataRows.has("irene")).toBe(false);
  });

  it("removeFromWhitelist deletes from bot_data:main via bot_whitelist_remove RPC", async () => {
    botDataRows.set("main", { id: "main", data: { server_whitelist: { "g-del": { name: "Doomed" } } } });

    const ok = await db.removeFromWhitelist("g-del");
    expect(ok).toBe(true);
    expect(rpcCalls.some((c) => c.fn === "bot_whitelist_remove" && c.args.p_guild_id === "g-del")).toBe(true);
    expect(await db.isWhitelisted("g-del")).toBe(false);
  });

  it("addToWhitelist falls back to read-modify-write on bot_data:main when the RPC is unavailable", async () => {
    rpcAvailable = false; // pre-migration-007 deployment
    const ok = await db.addToWhitelist("g-fallback", { name: "Fallback Server" });
    expect(ok).toBe(true);

    // Fallback path upserts the canonical id="main" row (never id="irene").
    expect(upsertCalls.some((u) => u.id === "main")).toBe(true);
    expect(upsertCalls.some((u) => u.id === "irene")).toBe(false);
    expect(botDataRows.get("main").data.server_whitelist["g-fallback"]).toMatchObject({ name: "Fallback Server" });
  });

  it("a whitelist write does NOT mark Irene's persisted blob dirty (server_whitelist is no longer a slice)", async () => {
    await db.addToWhitelist("g-x", { name: "X" });
    // The whitelist no longer flows through Irene's save() dirty-set — adding a
    // server must not dirty any persisted slice of the id="irene" blob.
    expect(db._internal.dirty.has("server_whitelist")).toBe(false);
    expect([...db._internal.dirty]).toEqual([]);
  });
});
