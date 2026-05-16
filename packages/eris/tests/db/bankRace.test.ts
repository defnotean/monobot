import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported. vi.hoisted() runs before any
// import statement, so config.supabaseEnabled sees these on first read.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// In-memory store the mock client reads/writes against. The atomic helpers
// (`bankDeposit`/`bankWithdraw`) run unmocked from `database.js`, so the
// real `withEconLock` and the read-check-debit-credit sequence are what's
// under test.
type EconRow = { user_id: string; balance: number; version: number; total_earned: number; total_lost: number; total_gambled: number };
type BankRow = { user_id: string; balance: number; last_interest: string | null };

const econ: Map<string, EconRow> = new Map();
const bankT: Map<string, BankRow> = new Map();

// Tunable yield so two concurrent calls' read-check-debit windows definitely
// interleave when the lock is missing.
let yieldDelayMs = 2;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  // Models `from("eris_economy").select("*").eq("user_id", uid).single()`
  // and `.update({...}).eq("user_id", uid).eq("version", v).select("user_id")`.
  return {
    select(_cols: string = "*") {
      return {
        eq(_col: string, val: any) {
          return {
            async single() {
              await delay(yieldDelayMs);
              const row = econ.get(val);
              return { data: row ? { ...row } : null, error: null };
            },
          };
        },
      };
    },
    update(updates: Partial<EconRow>) {
      return {
        eq(col1: string, val1: any) {
          return {
            eq(col2: string, val2: any) {
              return {
                async select(_cols: string = "*") {
                  await delay(yieldDelayMs);
                  const row = econ.get(val1);
                  if (!row) return { data: [], error: null };
                  // Optimistic concurrency check.
                  if ((row as any)[col2] !== val2) return { data: [], error: null };
                  Object.assign(row, updates);
                  return { data: [{ user_id: row.user_id }], error: null };
                },
              };
            },
          };
        },
      };
    },
    insert(_row: any) {
      // Bare insert (no .select chain) — return a thenable that resolves to ok.
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function makeBankChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(_col: string, val: any) {
          return {
            async single() {
              await delay(yieldDelayMs);
              const row = bankT.get(val);
              return { data: row ? { ...row } : null, error: null };
            },
          };
        },
      };
    },
    upsert(row: BankRow) {
      bankT.set(row.user_id, { ...row });
      return Promise.resolve({ data: null, error: null });
    },
    update(updates: Partial<BankRow>) {
      return {
        eq(_col: string, val: any) {
          const row = bankT.get(val);
          if (row) Object.assign(row, updates);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "eris_economy") return makeEconChain();
      if (table === "eris_bank") return makeBankChain();
      return makeNoopChain();
    },
    // RPC fast-path: return PGRST202 so the CAS fallback is exercised
    // (the deterministic, easily-mockable path).
    rpc(_name: string, _args: any) {
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeMockSupabase(),
}));

// Import AFTER mocks are set up.
// @ts-expect-error - importing JS module without types
import { initDatabase, bankDeposit, bankWithdraw } from "../../database.js";

function seedEcon(userId: string, balance: number) {
  econ.set(userId, {
    user_id: userId,
    balance,
    version: 0,
    total_earned: 0,
    total_lost: 0,
    total_gambled: 0,
  });
}

function seedBank(userId: string, balance: number) {
  bankT.set(userId, { user_id: userId, balance, last_interest: null });
}

describe("bankDeposit / bankWithdraw race safety", () => {
  beforeEach(async () => {
    econ.clear();
    bankT.clear();
    yieldDelayMs = 2;
    await initDatabase();
  });

  it("two parallel deposits never exceed wallet — total wallet+bank is conserved", async () => {
    // Wallet has exactly enough for ONE 600-coin deposit. Without locking,
    // both calls would pass the wallet check at 1000 and bank would grow by
    // 1200 against only 1000 deducted — coin creation.
    const userId = "race-deposit";
    seedEcon(userId, 1000);
    seedBank(userId, 0);

    const initialTotal = econ.get(userId)!.balance + (bankT.get(userId)?.balance ?? 0);

    const results = await Promise.all([
      bankDeposit(userId, 600),
      bankDeposit(userId, 600),
    ]);

    const ok = results.filter((r: any) => r.ok).length;
    const insufficient = results.filter(
      (r: any) => !r.ok && r.reason === "insufficient_wallet",
    ).length;

    expect(ok).toBe(1);
    expect(insufficient).toBe(1);

    const wallet = econ.get(userId)!.balance;
    const bank = bankT.get(userId)!.balance;
    expect(wallet + bank).toBe(initialTotal);
    expect(wallet).toBe(400);
    expect(bank).toBe(600);
  });

  it("two parallel withdrawals never exceed bank — total is conserved", async () => {
    const userId = "race-withdraw";
    seedEcon(userId, 0);
    seedBank(userId, 500);
    const initialTotal = econ.get(userId)!.balance + bankT.get(userId)!.balance;

    const results = await Promise.all([
      bankWithdraw(userId, 400),
      bankWithdraw(userId, 400),
    ]);

    const ok = results.filter((r: any) => r.ok).length;
    const insufficient = results.filter(
      (r: any) => !r.ok && r.reason === "insufficient_bank",
    ).length;

    expect(ok).toBe(1);
    expect(insufficient).toBe(1);

    const wallet = econ.get(userId)!.balance;
    const bank = bankT.get(userId)!.balance;
    expect(wallet + bank).toBe(initialTotal);
    expect(wallet).toBe(400);
    expect(bank).toBe(100);
  });

  it("refuses zero and negative amounts", async () => {
    const userId = "user-z";
    seedEcon(userId, 1000);
    seedBank(userId, 100);

    const zero = await bankDeposit(userId, 0);
    const neg = await bankDeposit(userId, -50);
    const zeroW = await bankWithdraw(userId, 0);
    const negW = await bankWithdraw(userId, -50);

    expect(zero.ok).toBe(false);
    expect(zero.reason).toBe("invalid_amount");
    expect(neg.ok).toBe(false);
    expect(neg.reason).toBe("invalid_amount");
    expect(zeroW.ok).toBe(false);
    expect(zeroW.reason).toBe("invalid_amount");
    expect(negW.ok).toBe(false);
    expect(negW.reason).toBe("invalid_amount");
  });
});
