import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// In-memory store the mock supabase reads/writes against.
const bankRows: Map<string, any> = new Map();
const marriageRows: any[] = [];

// Track DB hits so we can assert the cache actually serves reads / actually
// re-fetches after TTL expiry / invalidation.
let bankSelectCalls = 0;
let marriageSelectCalls = 0;

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "eris_bank") {
        return {
          select() {
            return {
              eq(_col: string, val: any) {
                return {
                  async single() {
                    bankSelectCalls++;
                    const row = bankRows.get(val);
                    return { data: row ? { ...row } : null, error: null };
                  },
                };
              },
            };
          },
          upsert(updates: any) {
            bankRows.set(updates.user_id, { ...updates });
            return Promise.resolve({ error: null });
          },
        } as any;
      }
      if (table === "eris_marriages") {
        return {
          select() {
            return {
              or(_filter: string) {
                return {
                  async single() {
                    marriageSelectCalls++;
                    // Pull whichever row matches either user1/user2.
                    // The filter string is `user1_id.eq.X,user2_id.eq.X` —
                    // we just need to know X. Tests pass userId directly
                    // through getMarriage so we can derive X by scanning.
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
          insert(updates: any) {
            return {
              select() {
                return {
                  async single() {
                    const row = { id: `m-${marriageRows.length}`, ...updates };
                    marriageRows.push(row);
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
          delete() {
            return {
              eq(_col: string, val: any) {
                const idx = marriageRows.findIndex((r) => r.id === val);
                if (idx >= 0) marriageRows.splice(idx, 1);
                return Promise.resolve({ error: null });
              },
            };
          },
        } as any;
      }
      // Other tables — noop chain.
      const chain: any = {};
      const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
        "order", "limit", "insert", "upsert", "update", "delete", "from"];
      for (const m of methods) chain[m] = () => chain;
      chain.single = async () => ({ data: null, error: null });
      chain.then = (resolve: any) => resolve({ data: null, error: null });
      return chain;
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeMockSupabase(),
}));

// @ts-expect-error - importing JS module without types
import { initDatabase, getBankBalance, updateBankBalance, createMarriage, deleteMarriage, getMarriage } from "../../database.js";

describe("_bankCache TTL + LRU eviction", () => {
  beforeEach(async () => {
    bankRows.clear();
    bankSelectCalls = 0;
    await initDatabase();
  });

  it("serves a cached read without hitting Supabase the second time", async () => {
    bankRows.set("u1", { user_id: "u1", balance: 250, last_interest: null });

    await getBankBalance("u1");
    const callsAfterFirst = bankSelectCalls;
    await getBankBalance("u1");
    const callsAfterSecond = bankSelectCalls;

    expect(callsAfterFirst).toBe(1);
    // Second call hit the cache, NOT supabase.
    expect(callsAfterSecond).toBe(1);
  });

  it("re-fetches after a write invalidation propagates", async () => {
    bankRows.set("u2", { user_id: "u2", balance: 100, last_interest: null });

    const first = await getBankBalance("u2");
    expect(first.balance).toBe(100);

    // Out-of-band update — without the cache being refreshed, this would be
    // silently shadowed. updateBankBalance refreshes the cache as a side
    // effect, so the next read sees the new value without an extra select.
    await updateBankBalance("u2", 50);
    const second = await getBankBalance("u2");
    expect(second.balance).toBe(150);
  });

  it("evicts cached row after TTL expires — out-of-band Supabase changes become visible", async () => {
    bankRows.set("u3", { user_id: "u3", balance: 200, last_interest: null });

    const cached = await getBankBalance("u3");
    expect(cached.balance).toBe(200);
    const callsAfterFirst = bankSelectCalls;

    // Simulate someone editing the row directly in the dashboard.
    bankRows.set("u3", { user_id: "u3", balance: 999, last_interest: null });

    // Within TTL — cache still serves stale data (this is the contract).
    const stillCached = await getBankBalance("u3");
    expect(stillCached.balance).toBe(200);
    expect(bankSelectCalls).toBe(callsAfterFirst);

    // Fast-forward past the 5-minute TTL.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    try {
      const refreshed = await getBankBalance("u3");
      // Cache expired → re-fetch picked up the dashboard edit.
      expect(refreshed.balance).toBe(999);
      expect(bankSelectCalls).toBe(callsAfterFirst + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("_marriageCache invalidation on createMarriage / deleteMarriage", () => {
  beforeEach(async () => {
    marriageRows.length = 0;
    marriageSelectCalls = 0;
    await initDatabase();
  });

  it("createMarriage seeds the cache for both users — no Supabase select", async () => {
    // Prime the cache with a "no marriage" entry for both users so we can
    // detect the invalidate-then-refresh.
    await getMarriage("alice");
    await getMarriage("bob");
    const baselineSelects = marriageSelectCalls;

    await createMarriage("alice", "bob");

    // Reads after createMarriage should hit cache (no extra selects).
    const aliceMarriage = await getMarriage("alice");
    const bobMarriage = await getMarriage("bob");

    expect(marriageSelectCalls).toBe(baselineSelects);
    expect(aliceMarriage).toBeTruthy();
    expect(aliceMarriage.user1_id).toBe("alice");
    expect(aliceMarriage.user2_id).toBe("bob");
    expect(bobMarriage).toBeTruthy();
    expect(bobMarriage.id).toBe(aliceMarriage.id);
  });

  it("deleteMarriage clears the cache for both users — getMarriage returns null without re-querying", async () => {
    const created = await createMarriage("carol", "dave");
    expect(created).toBeTruthy();

    // Confirm cache is populated.
    expect(await getMarriage("carol")).toBeTruthy();
    expect(await getMarriage("dave")).toBeTruthy();

    const beforeSelects = marriageSelectCalls;
    await deleteMarriage("carol");
    // Cache for both partners must now be `null`, served WITHOUT a fresh
    // supabase select.
    expect(await getMarriage("carol")).toBeNull();
    expect(await getMarriage("dave")).toBeNull();
    expect(marriageSelectCalls).toBe(beforeSelects);
  });
});
