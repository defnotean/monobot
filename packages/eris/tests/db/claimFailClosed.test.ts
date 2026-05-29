import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// Real claimDaily (withEconLock + fail-closed stamp-then-credit ordering) runs
// unmocked. We control whether the cooldown STAMP write succeeds to prove that
// a stamp failure aborts WITHOUT crediting, and that on success the cooldown is
// set so a second immediate claim is rejected.
type EconRow = {
  user_id: string;
  balance: number;
  version: number;
  total_earned: number;
  daily_streak: number;
  last_daily: string | null;
};

const econ: Map<string, EconRow> = new Map();
// When true, the cooldown-stamp UPDATE (single .eq, has daily_streak/last_daily)
// returns an error — simulating the stamp write failing.
let failStamp = false;

function makeNoopChain(): any {
  const chain: any = {};
  const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
    "order", "limit", "insert", "upsert", "update", "delete", "from"];
  for (const m of methods) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

function makeEconChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(_col: string, val: any) {
          return {
            async single() {
              const row = econ.get(val);
              return { data: row ? { ...row } : null, error: null };
            },
          };
        },
      };
    },
    update(updates: Partial<EconRow>) {
      // The cooldown STAMP path is `.update({daily_streak,last_daily}).eq(user_id)`
      // — awaited directly (a thenable), single .eq, no .select(). The CREDIT
      // (CAS) path is `.update({balance,version,...}).eq(user_id).eq(version).select()`.
      const isStamp = "last_daily" in updates || "daily_streak" in updates;
      return {
        eq(col1: string, val1: any) {
          const firstEq: any = {
            // Stamp path: caller awaits the result of this .eq() directly.
            then(resolve: any) {
              if (isStamp && failStamp) {
                return resolve({ data: null, error: { message: "simulated stamp write failure" } });
              }
              if (isStamp) {
                const row = econ.get(val1);
                if (row) Object.assign(row, updates);
                return resolve({ data: null, error: null });
              }
              return resolve({ data: null, error: null });
            },
            // Credit (CAS) path: a second .eq(version) then .select().
            eq(col2: string, val2: any) {
              return {
                async select(_cols: string = "*") {
                  const row = econ.get(val1);
                  if (!row) return { data: [], error: null };
                  if ((row as any)[col2] !== val2) return { data: [], error: null };
                  Object.assign(row, updates);
                  return { data: [{ user_id: row.user_id }], error: null };
                },
              };
            },
          };
          return firstEq;
        },
      };
    },
    insert(_row: any) { return Promise.resolve({ data: null, error: null }); },
  };
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "eris_economy") return makeEconChain();
      return makeNoopChain();
    },
    // Force the CAS fallback for the credit so we drive the JS reorder, not the RPC.
    rpc(_name: string, _args: any) {
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

// @ts-expect-error - importing JS module without types
import { initDatabase, claimDaily, getBalance } from "../../database.js";

function seedEcon(userId: string, balance: number) {
  econ.set(userId, {
    user_id: userId,
    balance,
    version: 0,
    total_earned: 0,
    daily_streak: 0,
    last_daily: null,
  });
}

describe("claimDaily fail-closed ordering", () => {
  beforeEach(async () => {
    econ.clear();
    failStamp = false;
    await initDatabase();
  });

  it("a stamp-write failure aborts WITHOUT crediting coins", async () => {
    const userId = "stamp-fails";
    seedEcon(userId, 500);

    failStamp = true;
    const result = await claimDaily(userId);

    // Claim must report failure and credit nothing — stamping precedes crediting.
    expect(result.success).toBe(false);
    expect((await getBalance(userId)).balance).toBe(500);
  });

  it("on success the cooldown is stamped and a second immediate claim is rejected", async () => {
    const userId = "happy-claim";
    seedEcon(userId, 500);

    const first = await claimDaily(userId);
    expect(first.success).toBe(true);
    // streak 1 → 50 base + 10 bonus = 60 coins credited.
    expect(first.coins).toBe(60);
    expect((await getBalance(userId)).balance).toBe(560);
    expect(econ.get(userId)!.last_daily).not.toBeNull();

    // Second immediate claim must hit the cooldown — no double credit.
    const second = await claimDaily(userId);
    expect(second.success).toBe(false);
    expect((await getBalance(userId)).balance).toBe(560);
  });
});
