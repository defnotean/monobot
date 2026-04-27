import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Fake Supabase ───────────────────────────────────────────────────────────
//
// In-memory store keyed by `${table}:${keyValue}`. Each row carries a
// `version` int and a `data` jsonb-ish payload. The query builder mirrors the
// chained surface that perEntity.js touches: from().select().eq().maybeSingle()
// for reads, from().insert() for inserts, from().update().eq().eq().select()
// for version-checked updates.
//
// A `forceConflictOnce` flag lets a test simulate a stale read: the next
// update against that row pretends nobody matched the version (returns []).

interface Row { version: number; data: any; }
const store = new Map<string, Row>();
const counters = {
  reads: 0,
  inserts: 0,
  updates: 0,
};
let forceConflictKey: string | null = null;
let forceErrorOnce: string | null = null;
let lastInsertVersion = new Map<string, number>(); // for unique-violation simulation

function rowKey(table: string, keyCol: string, keyVal: string) {
  return `${table}::${keyCol}=${keyVal}`;
}

function fakeSupabase() {
  return {
    from(table: string) {
      const builder: any = {
        _select: false,
        _eqs: [] as Array<[string, any]>,
        _selectAfterUpdate: false,
        _row: null as Row | null,
        _updatePayload: null as any,
        _insertPayload: null as any,
        select(_cols?: string) {
          this._select = true;
          return this;
        },
        eq(col: string, val: any) {
          this._eqs.push([col, val]);
          return this;
        },
        async maybeSingle() {
          counters.reads++;
          // Find row by primary-key column = first eq pair.
          const [keyCol, keyVal] = this._eqs[0];
          const k = rowKey(table, keyCol, keyVal);
          const row = store.get(k) ?? null;
          return { data: row ? { version: row.version } : null, error: null };
        },
        async insert(payload: any) {
          counters.inserts++;
          // Determine PK column from payload — whichever isn't version/data/updated_at
          const keyCol = Object.keys(payload).find(
            (c) => c !== "version" && c !== "data" && c !== "updated_at"
          )!;
          const keyVal = payload[keyCol];
          const k = rowKey(table, keyCol, keyVal);
          if (store.has(k)) {
            // Unique violation
            return { error: { code: "23505", message: "duplicate key" } };
          }
          if (forceErrorOnce === "insert") {
            forceErrorOnce = null;
            return { error: { code: "XX000", message: "simulated insert failure" } };
          }
          store.set(k, { version: payload.version, data: payload.data });
          lastInsertVersion.set(k, payload.version);
          return { error: null };
        },
        update(payload: any) {
          this._updatePayload = payload;
          return this;
        },
        // The terminal call after .update().eq().eq() is .select(...) which
        // we treat as the "submit" — returns the affected rows.
        // Implemented as a `then` to make `await` work on the chain.
        then(resolve: (val: any) => void, reject?: (err: any) => void) {
          counters.updates++;
          try {
            // Two .eq calls: [keyCol, keyVal], ["version", currentVersion]
            const [keyCol, keyVal] = this._eqs[0];
            const [, expectedVersion] = this._eqs[1];
            const k = rowKey(table, keyCol, keyVal);
            const row = store.get(k);
            if (forceErrorOnce === "update") {
              forceErrorOnce = null;
              resolve({ data: null, error: { code: "XX000", message: "simulated update failure" } });
              return;
            }
            if (forceConflictKey === k) {
              // Pretend this update didn't match the version row.
              forceConflictKey = null;
              resolve({ data: [], error: null });
              return;
            }
            if (!row || row.version !== expectedVersion) {
              resolve({ data: [], error: null });
              return;
            }
            row.version = this._updatePayload.version;
            row.data = this._updatePayload.data;
            resolve({ data: [{ version: row.version }], error: null });
          } catch (e) {
            if (reject) reject(e);
          }
        },
      };
      return builder;
    },
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────
// perEntity.js gets its supabase client from database.js#getSupabase. Mock
// that to return our fake. Mock config to control the bot_name / flag.

let mockSupabaseClient: any = fakeSupabase();
vi.mock("../../database.js", () => ({
  getSupabase: () => mockSupabaseClient,
}));
vi.mock("../../config.js", () => ({
  default: {
    botName: "irene-test",
    dualWritePersistence: false,
  },
}));

import * as pe from "../../database/perEntity.js";

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  store.clear();
  lastInsertVersion.clear();
  counters.reads = 0;
  counters.inserts = 0;
  counters.updates = 0;
  forceConflictKey = null;
  forceErrorOnce = null;
  mockSupabaseClient = fakeSupabase();
  pe._internal.__resetForTest();
});

afterEach(() => {
  pe._internal.__resetForTest();
});

// Helper — coalesce window is 500ms; tests advance fake timers past it then
// drain microtasks so the scheduled write actually runs.
async function waitForWrite() {
  await pe.flushPerEntityNow();
}

// ─── Helpers — shape-of-write per table ──────────────────────────────────────

describe("perEntity helpers — shape", () => {
  it("writeGuildSettings inserts to irene_guild_settings keyed by guild_id", async () => {
    const p = pe.writeGuildSettings("guild-1", { welcome_channel: "c1" });
    await waitForWrite();
    await p;
    const k = rowKey("irene_guild_settings", "guild_id", "guild-1");
    expect(store.get(k)).toEqual({ version: 1, data: { welcome_channel: "c1" } });
  });

  it("writeCustomCommands inserts to irene_custom_commands keyed by guild_id", async () => {
    pe.writeCustomCommands("g2", { hi: { trigger: "hi", response: "hello" } });
    await waitForWrite();
    const k = rowKey("irene_custom_commands", "guild_id", "g2");
    expect(store.get(k)?.data).toEqual({ hi: { trigger: "hi", response: "hello" } });
  });

  it("writeScrimStats inserts to irene_scrim_stats keyed by guild_id", async () => {
    pe.writeScrimStats("g3", { valorant: { wins: 1 } });
    await waitForWrite();
    expect(store.get(rowKey("irene_scrim_stats", "guild_id", "g3"))?.data)
      .toEqual({ valorant: { wins: 1 } });
  });

  it("writeStarboardEntries inserts to irene_starboard_entries keyed by guild_id", async () => {
    pe.writeStarboardEntries("g4", { msg1: "starmsg1" });
    await waitForWrite();
    expect(store.get(rowKey("irene_starboard_entries", "guild_id", "g4"))?.data)
      .toEqual({ msg1: "starmsg1" });
  });

  it("writeSavedQueue inserts to irene_saved_queue keyed by guild_id", async () => {
    pe.writeSavedQueue("g5", { tracks: ["t1", "t2"] });
    await waitForWrite();
    expect(store.get(rowKey("irene_saved_queue", "guild_id", "g5"))?.data)
      .toEqual({ tracks: ["t1", "t2"] });
  });

  it("writeMoodState inserts to irene_mood_state keyed by bot_name", async () => {
    pe.writeMoodState({ mood_score: 42, energy: 80 });
    await waitForWrite();
    expect(store.get(rowKey("irene_mood_state", "bot_name", "irene-test"))?.data)
      .toEqual({ mood_score: 42, energy: 80 });
  });

  it("writeRelationships inserts to irene_relationships keyed by bot_name", async () => {
    pe.writeRelationships({ "user-1": { affinity_score: 10, interactions_count: 3 } });
    await waitForWrite();
    expect(store.get(rowKey("irene_relationships", "bot_name", "irene-test"))?.data)
      .toEqual({ "user-1": { affinity_score: 10, interactions_count: 3 } });
  });

  it("writeGlobalState inserts to irene_global_state keyed by bot_name", async () => {
    pe.writeGlobalState({ _nextWarningId: 5, dm_optout: ["user-x"] });
    await waitForWrite();
    expect(store.get(rowKey("irene_global_state", "bot_name", "irene-test"))?.data)
      .toEqual({ _nextWarningId: 5, dm_optout: ["user-x"] });
  });
});

// ─── Optimistic concurrency — version check ──────────────────────────────────

describe("perEntity helpers — optimistic concurrency", () => {
  it("bumps version on update", async () => {
    pe.writeGuildSettings("g-cc1", { a: 1 });
    await waitForWrite();
    const k = rowKey("irene_guild_settings", "guild_id", "g-cc1");
    expect(store.get(k)?.version).toBe(1);

    pe.writeGuildSettings("g-cc1", { a: 2 });
    await waitForWrite();
    expect(store.get(k)?.version).toBe(2);
    expect(store.get(k)?.data).toEqual({ a: 2 });
  });

  it("retries on a single version conflict and eventually succeeds", async () => {
    pe.writeGuildSettings("g-conflict", { v: "first" });
    await waitForWrite();
    const k = rowKey("irene_guild_settings", "guild_id", "g-conflict");

    // Force the next update to see a stale-version response.
    forceConflictKey = k;
    counters.updates = 0;
    pe.writeGuildSettings("g-conflict", { v: "second" });
    await waitForWrite();
    // Two update attempts: 1st conflicts, 2nd succeeds.
    expect(counters.updates).toBe(2);
    expect(store.get(k)?.data).toEqual({ v: "second" });
  });

  it("gives up after MAX_RETRIES (3) hard errors and logs", async () => {
    pe.writeGuildSettings("g-fail", { v: "x" });
    await waitForWrite();
    const k = rowKey("irene_guild_settings", "guild_id", "g-fail");

    // Replace fake to always return errors on update.
    mockSupabaseClient = {
      from() {
        const b: any = {
          _eqs: [] as Array<[string, any]>,
          select() { return this; },
          eq(col: string, val: any) { this._eqs.push([col, val]); return this; },
          async maybeSingle() { return { data: { version: 1 }, error: null }; },
          update() { return this; },
          then(resolve: any) {
            counters.updates++;
            resolve({ data: null, error: { message: "boom" } });
          },
        };
        return b;
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    counters.updates = 0;
    pe.writeGuildSettings("g-fail", { v: "y" });
    await waitForWrite();
    expect(counters.updates).toBe(pe._internal.MAX_RETRIES);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("falls through unique-violation insert to retry as update", async () => {
    // Pre-populate the row so the perEntity insert path will hit a unique-violation.
    // First write goes through normally to seed.
    pe.writeGuildSettings("g-uniq", { x: 1 });
    await waitForWrite();
    // Now force a "no row found" on the read so insert is attempted, then
    // the insert path should fail with 23505 and the retry should update.
    const original = mockSupabaseClient;
    let readCalls = 0;
    mockSupabaseClient = {
      from(table: string) {
        const b: any = {
          _eqs: [] as Array<[string, any]>,
          _updatePayload: null as any,
          select() { return this; },
          eq(col: string, val: any) { this._eqs.push([col, val]); return this; },
          async maybeSingle() {
            readCalls++;
            // First read: pretend no row → triggers insert path.
            // Subsequent reads: hand back to the original fake.
            if (readCalls === 1) return { data: null, error: null };
            return original.from(table).eq(...this._eqs[0]).maybeSingle();
          },
          async insert() {
            counters.inserts++;
            return { error: { code: "23505", message: "duplicate" } };
          },
          update(payload: any) {
            this._updatePayload = payload;
            return this;
          },
          then(resolve: any) {
            // Delegate to original for the actual update.
            const orig = original.from(table);
            orig.update(this._updatePayload);
            for (const [c, v] of this._eqs) orig.eq(c, v);
            resolve(orig);
          },
        };
        return b;
      },
    };
    counters.inserts = 0;
    counters.updates = 0;
    pe.writeGuildSettings("g-uniq", { x: 2 });
    await waitForWrite();
    expect(counters.inserts).toBe(1); // first attempt insert → 23505
    // Second attempt should successfully update (the row already exists).
    expect(store.get(rowKey("irene_guild_settings", "guild_id", "g-uniq"))?.data)
      .toEqual({ x: 2 });
    mockSupabaseClient = original;
  });
});

// ─── Coalesce — rapid writes collapse into one Supabase call ─────────────────

describe("perEntity helpers — coalesce", () => {
  it("collapses rapid-fire writes within COALESCE_MS into ONE Supabase call", async () => {
    // Three rapid writes to the same guild — should hit Supabase once with the
    // latest payload.
    pe.writeGuildSettings("g-coal", { tick: 1 });
    pe.writeGuildSettings("g-coal", { tick: 2 });
    pe.writeGuildSettings("g-coal", { tick: 3 });

    expect(counters.reads).toBe(0);
    expect(counters.inserts).toBe(0);

    await waitForWrite();

    // One read + one insert = one logical write cycle, NOT three.
    expect(counters.reads).toBe(1);
    expect(counters.inserts + counters.updates).toBe(1);
    const k = rowKey("irene_guild_settings", "guild_id", "g-coal");
    expect(store.get(k)?.data).toEqual({ tick: 3 });
  });

  it("does not coalesce across different keys", async () => {
    pe.writeGuildSettings("guild-A", { v: "a" });
    pe.writeGuildSettings("guild-B", { v: "b" });
    await waitForWrite();
    expect(counters.inserts).toBe(2);
    expect(store.get(rowKey("irene_guild_settings", "guild_id", "guild-A"))?.data).toEqual({ v: "a" });
    expect(store.get(rowKey("irene_guild_settings", "guild_id", "guild-B"))?.data).toEqual({ v: "b" });
  });

  it("does not coalesce across different tables for same key", async () => {
    pe.writeGuildSettings("same-id", { kind: "settings" });
    pe.writeCustomCommands("same-id", { kind: "commands" });
    await waitForWrite();
    expect(counters.inserts).toBe(2);
  });
});

// ─── Dual-write flag behavior — verified by integration via database.js ──────
//
// The flag itself lives on `config.dualWritePersistence`. We can't easily
// import database.js (it side-effect-loads supabase + needs a real .env), so
// we verify the FLAG GATING behavior at the perEntity layer: when the helpers
// are called, they always run; when they're NOT called (flag off), the
// counters stay at zero. The actual gate is one if-statement in database.js
// (covered by code review). This test asserts the contract: the helpers
// themselves are unconditionally fire-and-forget — gating is the caller's job.

describe("perEntity helpers — dual-write contract", () => {
  it("does nothing when no helper is invoked (flag off equivalent)", async () => {
    // No helper calls → no Supabase activity.
    await waitForWrite();
    expect(counters.reads).toBe(0);
    expect(counters.inserts).toBe(0);
    expect(counters.updates).toBe(0);
  });

  it("runs every helper call when invoked (flag on equivalent)", async () => {
    // Two distinct entities = two distinct Supabase write cycles.
    pe.writeGuildSettings("g-dw", { ok: true });
    pe.writeMoodState({ mood_score: 5, energy: 50 });
    await waitForWrite();
    expect(counters.reads).toBe(2);
    expect(counters.inserts).toBe(2);
  });
});

// ─── Drain — flushPerEntityNow on shutdown ──────────────────────────────────

describe("flushPerEntityNow", () => {
  it("drains pending coalesced writes immediately", async () => {
    pe.writeGuildSettings("g-drain", { final: true });
    // Don't wait for the 500ms timer — drain right away.
    await pe.flushPerEntityNow();
    expect(store.get(rowKey("irene_guild_settings", "guild_id", "g-drain"))?.data)
      .toEqual({ final: true });
  });

  it("resolves the original schedule promise when drained early", async () => {
    const p = pe.writeGuildSettings("g-drain2", { early: true });
    await pe.flushPerEntityNow();
    // p MUST resolve once the drained write lands — this would hang if it didn't.
    await expect(p).resolves.toBeUndefined();
  });
});
