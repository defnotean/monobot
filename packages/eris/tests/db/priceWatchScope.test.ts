// Cross-user data-leak regression — getPriceWatches must be scoped to ONE user.
//
// THE BUG (pre-fix): getPriceWatches(_userId) ignored its param and ran a bare
// `select("*")` over eris_price_watches, returning EVERY user's watches (their
// URLs, product names, target prices). The `unwatch_price` tool passes
// message.author.id expecting per-user scoping, and `check_prices` is described
// as "their tracked prices" — both leaked / let a user unwatch OTHER users' rows.
//
// This suite proves:
//   - getPriceWatches(userId) returns ONLY that user's rows (the leak fix).
//     FAILS on the old impl (it returns both users' rows because no .eq filter
//     was ever applied).
//   - getPriceWatches() with no/empty id returns [] rather than everyone's rows
//     (the param is now REQUIRED — don't silently return all users).
//   - removePriceWatch stays user-scoped (can't delete another user's watch).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

type WatchRow = {
  id?: number;
  user_id?: string;
  channel_id?: string;
  url?: string;
  product_name?: string;
  target_price?: number;
};

const watches: WatchRow[] = [];
// Records how the most recent select() was filtered, so we can assert the query
// actually scoped to user_id (an unfiltered select is the leak).
let lastSelectFilteredByUser = false;

function makePriceWatchChain() {
  return {
    insert(row: WatchRow) {
      watches.push({ id: watches.length + 1, ...row });
      return Promise.resolve({ data: null, error: null });
    },
    select(_cols: string) {
      lastSelectFilteredByUser = false;
      const filters: Array<(r: WatchRow) => boolean> = [];
      const builder: any = {
        eq(col: keyof WatchRow, val: unknown) {
          if (col === "user_id") lastSelectFilteredByUser = true;
          filters.push(r => r[col] === val);
          return builder;
        },
        then(resolve: (v: { data: WatchRow[]; error: null }) => unknown) {
          const rows = watches.filter(r => filters.every(f => f(r)));
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
    delete() {
      const filters: Array<(r: WatchRow) => boolean> = [];
      const builder: any = {
        eq(col: keyof WatchRow, val: unknown) { filters.push(r => r[col] === val); return builder; },
        then(resolve: (v: { data: null; error: null }) => unknown) {
          const survivors = watches.filter(r => !filters.every(f => f(r)));
          watches.length = 0; watches.push(...survivors);
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

function makeNoopChain(): any {
  const chain: any = {};
  for (const m of ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or", "not", "order", "limit", "insert", "upsert", "update", "delete", "from"]) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "eris_price_watches") return makePriceWatchChain();
      return makeNoopChain();
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

let db: any;

const USER_A = "111111111111111111";
const USER_B = "222222222222222222";

describe("getPriceWatches user scoping (cross-user leak fix)", () => {
  beforeEach(async () => {
    watches.length = 0;
    lastSelectFilteredByUser = false;
    vi.resetModules();
    db = await import("../../database.js");
    await db.initDatabase();
    // Two users each with their own watch.
    await db.addPriceWatch(USER_A, "chanA", "https://shop/a", "Laptop A", 999);
    await db.addPriceWatch(USER_B, "chanB", "https://shop/b", "Phone B", 599);
  });

  it("returns ONLY the requested user's watches (not other users')", async () => {
    const aWatches = await db.getPriceWatches(USER_A);
    // Old impl returned BOTH rows here (no .eq filter) — this length assertion
    // is the one that fails on the leak.
    expect(aWatches).toHaveLength(1);
    expect(aWatches[0].user_id).toBe(USER_A);
    expect(aWatches.every((w: WatchRow) => w.user_id === USER_A)).toBe(true);
    // No row belonging to USER_B may surface in USER_A's result.
    expect(aWatches.some((w: WatchRow) => w.user_id === USER_B)).toBe(false);
    // And the query must have actually filtered on user_id.
    expect(lastSelectFilteredByUser).toBe(true);
  });

  it("scopes USER_B symmetrically", async () => {
    const bWatches = await db.getPriceWatches(USER_B);
    expect(bWatches).toHaveLength(1);
    expect(bWatches[0].product_name).toBe("Phone B");
    expect(bWatches.some((w: WatchRow) => w.user_id === USER_A)).toBe(false);
  });

  it("returns [] (not everyone's rows) when called with no/empty id", async () => {
    // Param is REQUIRED — a missing id must NOT fall back to leaking all users.
    expect(await db.getPriceWatches()).toEqual([]);
    expect(await db.getPriceWatches("")).toEqual([]);
    expect(await db.getPriceWatches(undefined)).toEqual([]);
  });

  it("legitimate single-user unwatch flow still works", async () => {
    // unwatch_price resolves a product name → id via the (now scoped) read,
    // then deletes by id + user_id.
    const mine = await db.getPriceWatches(USER_A);
    const id = mine[0].id;
    const ok = await db.removePriceWatch(USER_A, id);
    expect(ok).toBe(true);
    expect(await db.getPriceWatches(USER_A)).toHaveLength(0);
    // USER_B's watch is untouched.
    expect(await db.getPriceWatches(USER_B)).toHaveLength(1);
  });

  it("removePriceWatch cannot delete another user's watch", async () => {
    const bWatch = (await db.getPriceWatches(USER_B))[0];
    // USER_A tries to remove USER_B's watch id — delete is user-scoped, so the
    // row survives.
    await db.removePriceWatch(USER_A, bWatch.id);
    expect(await db.getPriceWatches(USER_B)).toHaveLength(1);
  });
});
