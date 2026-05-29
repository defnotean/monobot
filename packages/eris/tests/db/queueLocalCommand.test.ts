import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
  // A configured secret so the signed path would add a `sig` column too — the
  // pre-migration table must reject BOTH new columns and still fall back.
  process.env.TWIN_API_SECRET = "test-secret-not-real";
});

// Captures every row passed to local_commands.insert(...) in order.
const inserts: any[] = [];
// When true, the table is pre-migration-004: any insert carrying `ts` or `sig`
// is rejected with the PostgREST "column not found" error, mirroring a real
// deployment where 004_local_commands_signature.sql has not been applied.
let preMigration = false;

function makeNoopChain(): any {
  const chain: any = {};
  const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
    "order", "limit", "insert", "upsert", "update", "delete", "from"];
  for (const m of methods) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

function makeLocalCommandsChain() {
  return {
    insert(row: any) {
      inserts.push({ ...row });
      if (preMigration && ("ts" in row || "sig" in row)) {
        return Promise.resolve({
          data: null,
          error: { code: "PGRST204", message: "Could not find the 'ts' column of 'local_commands' in the schema cache" },
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "local_commands") return makeLocalCommandsChain();
      return makeNoopChain();
    },
    rpc(_name: string, _args: any) {
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

// The `_localCmdSigColsAvailable` latch is module-level state that survives
// across `it` blocks, so re-import a FRESH database module per test (vi.resetModules)
// to isolate the latch — otherwise the signed-row test would be poisoned by an
// earlier pre-migration test that flipped the columns off.
let queueLocalCommand: (cmd: string, chan: string, by: string) => Promise<boolean>;

describe("queueLocalCommand pre-migration-004 degradation", () => {
  beforeEach(async () => {
    inserts.length = 0;
    preMigration = false;
    vi.resetModules();
    const db: any = await import("../../database.js");
    queueLocalCommand = db.queueLocalCommand;
    await db.initDatabase();
  });

  it("falls back to a legacy (no sig/ts) row when the sig/ts columns are missing", async () => {
    preMigration = true;
    const ok = await queueLocalCommand("notepad.exe", "chan-1", "user-1");

    // Must succeed via the retry — NOT return false like the broken version.
    expect(ok).toBe(true);
    // Two inserts: the signed attempt (rejected) then the legacy retry.
    expect(inserts.length).toBe(2);
    expect("ts" in inserts[0] || "sig" in inserts[0]).toBe(true);
    // The retry row carries only the legacy columns.
    expect(inserts[1]).toEqual({
      command: "notepad.exe",
      channel_id: "chan-1",
      requested_by: "user-1",
      status: "pending",
    });
  });

  it("latches the columns off so later enqueues skip the failing signed insert", async () => {
    preMigration = true;
    const first = await queueLocalCommand("a", "c", "u");
    expect(first).toBe(true);
    expect(inserts.length).toBe(2); // signed attempt + legacy retry

    inserts.length = 0;
    const second = await queueLocalCommand("b", "c", "u");
    expect(second).toBe(true);
    // Latched off — a single legacy insert, no wasted signed attempt.
    expect(inserts.length).toBe(1);
    expect("ts" in inserts[0]).toBe(false);
    expect("sig" in inserts[0]).toBe(false);
  });

  it("writes a signed row with sig + ts when the columns exist", async () => {
    preMigration = false;
    const ok = await queueLocalCommand("dir", "chan-2", "user-2");

    expect(ok).toBe(true);
    expect(inserts.length).toBe(1);
    expect(typeof inserts[0].ts).toBe("number");
    expect(typeof inserts[0].sig).toBe("string");
    expect(inserts[0].sig.length).toBeGreaterThan(0);
  });
});
