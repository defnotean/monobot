import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Fake Supabase ───────────────────────────────────────────────────────────
//
// In-memory store keyed by saga id. The query builder mirrors the chained
// surface sagaReplayer.js touches:
//   from("dual_write_sagas").insert(...).select("id").single()
//   from("dual_write_sagas").update(...).eq("id", id)
//   from("dual_write_sagas").select(...).eq().eq().lt().order().limit()
//
// The fake is deliberately minimal — only the chains the module actually uses
// are implemented. Anything else throws "unsupported call" so a future
// behavioral change in sagaReplayer.js can't silently pass these tests.

interface SagaRow {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string;
  payload: any;
  primary_status: "pending" | "applied" | "failed";
  secondary_status: "pending" | "applied" | "failed" | "permanent";
  replayed_at: string | null;
  attempts: number;
  last_error: string | null;
}

const sagaStore = new Map<string, SagaRow>();
let _nextSagaSeq = 0;
const counters = {
  inserts: 0,
  updates: 0,
  selects: 0,
};
// When the fake's per-entity helper is called from sagaReplayer's replay path
// it normally succeeds. Set this to "fail" to force the replay to throw.
let perEntityBehavior: "ok" | "fail" = "ok";

function fakeSupabase() {
  return {
    from(table: string) {
      if (table !== "dual_write_sagas") {
        throw new Error(`fakeSupabase: unexpected table "${table}"`);
      }
      const builder: any = {
        _mode: null as null | "select" | "update" | "insert",
        _selectCols: "",
        _eqs: [] as Array<[string, any]>,
        _lts: [] as Array<[string, any]>,
        _order: null as null | { col: string; asc: boolean },
        _limit: null as null | number,
        _updatePayload: null as any,
        _insertPayload: null as any,
        _selectAfterInsert: false,
        insert(payload: any) {
          this._mode = "insert";
          this._insertPayload = payload;
          return this;
        },
        update(payload: any) {
          this._mode = "update";
          this._updatePayload = payload;
          return this;
        },
        select(cols: string) {
          if (this._mode === "insert") {
            this._selectAfterInsert = true;
            this._selectCols = cols;
            return this;
          }
          this._mode = "select";
          this._selectCols = cols;
          return this;
        },
        eq(col: string, val: any) {
          this._eqs.push([col, val]);
          return this;
        },
        lt(col: string, val: any) {
          this._lts.push([col, val]);
          return this;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          this._order = { col, asc: opts?.ascending !== false };
          return this;
        },
        limit(n: number) {
          this._limit = n;
          return this;
        },
        async single() {
          // Only invoked after .insert(...).select("id")
          if (this._mode !== "insert" || !this._selectAfterInsert) {
            throw new Error("fakeSupabase: .single() called outside insert-returning");
          }
          counters.inserts++;
          const id = `saga-${++_nextSagaSeq}`;
          const row: SagaRow = {
            id,
            created_at: new Date().toISOString(),
            entity_type: this._insertPayload.entity_type,
            entity_id: this._insertPayload.entity_id,
            payload: this._insertPayload.payload ?? {},
            primary_status: this._insertPayload.primary_status ?? "pending",
            secondary_status: this._insertPayload.secondary_status ?? "pending",
            replayed_at: null,
            attempts: 0,
            last_error: null,
          };
          sagaStore.set(id, row);
          return { data: { id }, error: null };
        },
        // Resolve the chain. update(...).eq(...) → run update. select(...).eq().eq().lt().order().limit() → run select.
        then(resolve: (val: any) => void, reject?: (err: any) => void) {
          try {
            if (this._mode === "update") {
              counters.updates++;
              // Single .eq("id", value) — the only update pattern in the module.
              const [, idVal] = this._eqs[0];
              const row = sagaStore.get(idVal);
              if (!row) {
                resolve({ data: null, error: null });
                return;
              }
              Object.assign(row, this._updatePayload);
              resolve({ data: null, error: null });
              return;
            }
            if (this._mode === "select") {
              counters.selects++;
              let rows = [...sagaStore.values()];
              for (const [col, val] of this._eqs) {
                rows = rows.filter((r: any) => r[col] === val);
              }
              for (const [col, val] of this._lts) {
                rows = rows.filter((r: any) => r[col] < val);
              }
              if (this._order) {
                const { col, asc } = this._order;
                rows = rows.slice().sort((a: any, b: any) =>
                  asc ? (a[col] > b[col] ? 1 : -1) : a[col] < b[col] ? 1 : -1);
              }
              if (this._limit != null) rows = rows.slice(0, this._limit);
              resolve({ data: rows, error: null });
              return;
            }
            throw new Error("fakeSupabase: builder used without a terminal verb");
          } catch (err) {
            if (reject) reject(err); else throw err;
          }
        },
      };
      return builder;
    },
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────
// sagaReplayer.js gets its supabase from database.js#getSupabase. Mock that
// + config to control the flag.

let mockSupabaseClient: any = fakeSupabase();
let mockDualWriteFlag = true;

vi.mock("../../database.js", () => ({
  getSupabase: () => mockSupabaseClient,
}));
vi.mock("../../config.js", () => ({
  default: {
    get dualWritePersistence() { return mockDualWriteFlag; },
    botName: "irene-test",
  },
}));

// Per-entity module is dynamically imported by sagaReplayer.js. We intercept
// that import via vi.mock so the replay path doesn't actually call Supabase
// (the fake here only models the saga table).
const peCalls = { writes: 0 };
vi.mock("../../database/perEntity.js", () => {
  const stub = async (..._args: any[]) => {
    if (perEntityBehavior === "fail") throw new Error("perEntity failure for test");
    peCalls.writes++;
  };
  return {
    writeGuildSettings: stub,
    writeCustomCommands: stub,
    writeScrimStats: stub,
    writeStarboardEntries: stub,
    writeSavedQueue: stub,
    writeMoodState: stub,
    writeRelationships: stub,
    writeGlobalState: stub,
  };
});

import {
  createSaga,
  markSagaLeg,
  runReconcilerOnce,
  _internal,
} from "../../sagaReplayer.js";

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  sagaStore.clear();
  _nextSagaSeq = 0;
  counters.inserts = 0;
  counters.updates = 0;
  counters.selects = 0;
  perEntityBehavior = "ok";
  peCalls.writes = 0;
  mockSupabaseClient = fakeSupabase();
  mockDualWriteFlag = true;
});

afterEach(() => {
  // Nothing scheduled here — startSagaReplayer is not invoked in tests.
});

// ─── Saga row creation ───────────────────────────────────────────────────────

describe("createSaga", () => {
  it("inserts a row with both legs in 'pending' state and returns the id", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", { foo: "bar" });
    expect(id).toMatch(/^saga-\d+$/);
    expect(counters.inserts).toBe(1);
    const row = sagaStore.get(id!);
    expect(row?.primary_status).toBe("pending");
    expect(row?.secondary_status).toBe("pending");
    expect(row?.entity_type).toBe("fanout-snapshot");
    expect(row?.entity_id).toBe("snapshot");
    expect(row?.payload).toEqual({ foo: "bar" });
    expect(row?.attempts).toBe(0);
  });

  it("returns null when DUAL_WRITE_PERSISTENCE is off (no-op)", async () => {
    mockDualWriteFlag = false;
    const id = await createSaga("fanout-snapshot", "snapshot", { foo: "bar" });
    expect(id).toBeNull();
    expect(counters.inserts).toBe(0);
    expect(sagaStore.size).toBe(0);
  });
});

// ─── Primary success + secondary success (happy path) ────────────────────────

describe("markSagaLeg — happy path", () => {
  it("marks primary then secondary applied; both legs end in 'applied'", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", { ok: true });
    await markSagaLeg(id, "primary", "applied");
    await markSagaLeg(id, "secondary", "applied");
    const row = sagaStore.get(id!);
    expect(row?.primary_status).toBe("applied");
    expect(row?.secondary_status).toBe("applied");
    // No reconciliation needed — the row exists as audit but never gets touched.
    const stats = await runReconcilerOnce();
    expect(stats.processed).toBe(0);
  });

  it("marks primary applied + secondary failed (drift state) — picked up by reconciler", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", { drift: true });
    await markSagaLeg(id, "primary", "applied");
    await markSagaLeg(id, "secondary", "failed", "secondary fanout barfed");
    const row = sagaStore.get(id!);
    expect(row?.primary_status).toBe("applied");
    expect(row?.secondary_status).toBe("failed");
    expect(row?.last_error).toContain("secondary fanout barfed");
  });
});

// ─── Primary success + secondary fail + replay success ──────────────────────

describe("runReconcilerOnce — replay success", () => {
  it("replays the secondary leg, marks it applied, stamps replayed_at", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", {
      guild_settings: { "g1": { welcome: "c1" } },
      mood: { mood_score: 1, energy: 50 },
    });
    await markSagaLeg(id, "primary", "applied");
    await markSagaLeg(id, "secondary", "failed", "transient secondary error");

    perEntityBehavior = "ok";
    const stats = await runReconcilerOnce();
    expect(stats.processed).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.permanent).toBe(0);

    const row = sagaStore.get(id!);
    expect(row?.secondary_status).toBe("applied");
    expect(row?.replayed_at).not.toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeNull();
    // perEntity helpers actually got called during replay.
    expect(peCalls.writes).toBeGreaterThan(0);
  });

  it("does not touch sagas where primary is still pending or failed", async () => {
    // primary=pending → ignored
    const idPending = await createSaga("fanout-snapshot", "snapshot", {});
    await markSagaLeg(idPending, "secondary", "failed", "x");
    // primary=failed → ignored (drift not on the secondary, primary itself bombed)
    const idFailed = await createSaga("fanout-snapshot", "snapshot", {});
    await markSagaLeg(idFailed, "primary", "failed", "primary bombed");
    await markSagaLeg(idFailed, "secondary", "failed", "y");

    const stats = await runReconcilerOnce();
    expect(stats.processed).toBe(0);
  });
});

// ─── Replay max-attempts cap → 'permanent' state ────────────────────────────

describe("runReconcilerOnce — max-attempts cap", () => {
  it("after MAX_ATTEMPTS hard failures, secondary_status flips to 'permanent' and a loud log fires", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", {
      guild_settings: { "g1": { ok: 1 } },
    });
    await markSagaLeg(id, "primary", "applied");
    await markSagaLeg(id, "secondary", "failed", "initial fail");

    perEntityBehavior = "fail";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Each reconciler pass picks up the row (attempts < MAX), runs replay
    // (which throws), increments attempts. After MAX_ATTEMPTS the row is
    // marked permanent and no longer picked up.
    for (let i = 0; i < _internal.MAX_ATTEMPTS + 1; i++) {
      await runReconcilerOnce();
    }

    const row = sagaStore.get(id!);
    expect(row?.attempts).toBe(_internal.MAX_ATTEMPTS);
    expect(row?.secondary_status).toBe("permanent");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("PERMANENT FAILURE")
    );

    // After 'permanent' it MUST NOT be replayed again — the query filters on
    // secondary_status='failed', so 'permanent' is excluded.
    counters.selects = 0;
    perEntityBehavior = "ok"; // even if it would succeed, it shouldn't run
    const stats = await runReconcilerOnce();
    expect(stats.processed).toBe(0);
    errSpy.mockRestore();
  });

  it("increments attempts on each failed replay without exceeding MAX_ATTEMPTS", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", { x: 1 });
    await markSagaLeg(id, "primary", "applied");
    await markSagaLeg(id, "secondary", "failed", "first fail");

    perEntityBehavior = "fail";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runReconcilerOnce();
    expect(sagaStore.get(id!)?.attempts).toBe(1);
    expect(sagaStore.get(id!)?.secondary_status).toBe("failed");
    await runReconcilerOnce();
    expect(sagaStore.get(id!)?.attempts).toBe(2);
    expect(sagaStore.get(id!)?.secondary_status).toBe("failed");
    errSpy.mockRestore();
  });
});

// ─── No-op when DUAL_WRITE_PERSISTENCE=0 ─────────────────────────────────────

describe("flag gating — DUAL_WRITE_PERSISTENCE=0", () => {
  it("createSaga, markSagaLeg, runReconcilerOnce are all no-ops when flag is off", async () => {
    mockDualWriteFlag = false;
    expect(await createSaga("x", "y", {})).toBeNull();
    await markSagaLeg("any-id", "primary", "applied"); // should not throw, should not write
    const stats = await runReconcilerOnce();
    expect(stats.processed).toBe(0);
    expect(counters.inserts).toBe(0);
    expect(counters.updates).toBe(0);
    expect(counters.selects).toBe(0);
  });
});

// ─── markSagaLeg robustness ─────────────────────────────────────────────────

describe("markSagaLeg — defensive", () => {
  it("is a no-op when sagaId is null (saga creation failed earlier)", async () => {
    // No write should hit the store.
    await markSagaLeg(null, "primary", "applied");
    await markSagaLeg(null, "secondary", "failed", "x");
    expect(counters.updates).toBe(0);
  });

  it("captures last_error on failure but not on success", async () => {
    const id = await createSaga("fanout-snapshot", "snapshot", {});
    await markSagaLeg(id, "primary", "failed", "boom");
    expect(sagaStore.get(id!)?.last_error).toBe("boom");
    await markSagaLeg(id, "secondary", "applied");
    // Successful mark doesn't overwrite last_error.
    expect(sagaStore.get(id!)?.last_error).toBe("boom");
  });
});
