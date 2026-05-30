import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported so config.supabaseEnabled is true
// and the real database.js wires up our mock client instead of the in-memory
// fallback. vi.hoisted() runs before any import statement.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// ─────────────────────────────────────────────────────────────────────────────
// Backing stores for the mocked Supabase client. These exercise the REAL
// optimistic-locking / retry logic in database/inventory.js (tryDecrement /
// tryIncrement shop stock, inventory CRUD, the achievements unique constraint).
// ─────────────────────────────────────────────────────────────────────────────

type ShopRow = { id: string; guild_id: string | null; name?: string; price?: number; limited_stock: number | null };
type InvRow = { id: number; user_id: string; item_name: string; item_type: string | null };
type AchRow = { id: number; user_id: string; achievement_key: string; unlocked_at: string };

const shop: Map<string, ShopRow> = new Map();
let inventory: InvRow[] = [];
let invSeq = 1;
let achievements: AchRow[] = [];
let achSeq = 1;

// Toggles to drive error / edge branches.
let shopReadError: { message: string } | null = null;
let shopWriteError: { message: string } | null = null;
// When >0, the next N optimistic updates "lose the race": the .eq guard is
// silently bumped out from under us so updated.length === 0 and the loop retries.
let stealNextUpdates = 0;

function makeShopChain() {
  return {
    select(_cols: string = "*") {
      return {
        // getShopItems: .select("*").or(...).order("price")
        or(_filter: string) {
          return {
            order(_col: string) {
              const rows = [...shop.values()].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
              return { then: (resolve: any) => resolve({ data: rows.map(r => ({ ...r })), error: null }) };
            },
          };
        },
        // tryDecrement/Increment: .select("limited_stock").eq("id", id).single()
        eq(col: string, val: any) {
          return {
            async single() {
              if (shopReadError) return { data: null, error: shopReadError };
              const row = col === "id" ? shop.get(val) : undefined;
              return { data: row ? { limited_stock: row.limited_stock } : null, error: null };
            },
          };
        },
      };
    },
    insert(row: any) {
      const id = row.id ?? `shop-${shop.size + 1}`;
      shop.set(id, { id, guild_id: row.guild_id ?? null, name: row.name, price: row.price, limited_stock: row.limited_stock ?? null });
      return Promise.resolve({ data: null, error: null });
    },
    update(updates: Partial<ShopRow>) {
      return {
        eq(col1: string, val1: any) {
          return {
            // .eq("limited_stock", lastSeen).select("id")
            eq(col2: string, val2: any) {
              return {
                async select(_cols: string = "id") {
                  if (shopWriteError) return { data: null, error: shopWriteError };
                  const row = shop.get(val1);
                  if (!row) return { data: [], error: null };
                  // Simulate a competing writer: mutate the guarded column so the
                  // optimistic check fails for this attempt.
                  if (stealNextUpdates > 0) {
                    stealNextUpdates--;
                    (row as any)[col2] = (row as any)[col2] + 1; // move the value
                    return { data: [], error: null };
                  }
                  if ((row as any)[col2] !== val2) return { data: [], error: null };
                  Object.assign(row, updates);
                  return { data: [{ id: row.id }], error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

// Inventory chain mirrors database/inventory.js usage exactly:
//   getInventory:        .select("*").eq("user_id", u).order("acquired_at", ...)
//   addToInventory:      .insert({...})
//   removeFromInventory: .select("id, item_type").eq(u).eq(item).limit(1).single()
//                        then .delete().eq("id", id)
//   hasItem:             .select("id").eq(u).eq(item).limit(1)  (array)
function makeInventoryChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(col1: string, val1: any) {
          // getInventory: .eq(user).order(...)
          const orderApi = {
            order(_c: string, _o: any) {
              const rows = inventory.filter(r => r.user_id === val1).map(r => ({ ...r }));
              return { then: (resolve: any) => resolve({ data: rows, error: null }) };
            },
            // remove/has: .eq(item).limit(1)
            eq(_col2: string, val2: any) {
              const matched = inventory.filter(r => r.user_id === val1 && r.item_name === val2);
              return {
                limit(_n: number) {
                  const limited = matched.slice(0, 1).map(r => ({ id: r.id, item_type: r.item_type }));
                  return {
                    then: (resolve: any) => resolve({ data: limited, error: null }),
                    async single() { return { data: limited[0] || null, error: null }; },
                  };
                },
              };
            },
          };
          return orderApi;
        },
      };
    },
    insert(row: any) {
      inventory.push({ id: invSeq++, user_id: row.user_id, item_name: row.item_name, item_type: row.item_type ?? null });
      return Promise.resolve({ data: null, error: null });
    },
    delete() {
      return {
        eq(_col: string, val: any) {
          const idx = inventory.findIndex(r => r.id === val);
          if (idx >= 0) inventory.splice(idx, 1);
          return { then: (resolve: any) => resolve({ data: null, error: null }) };
        },
      };
    },
  };
}

// Achievements chain:
//   unlockAchievement:        .insert({...}) → error iff duplicate key
//   getUnlockedAchievements:  .select("...").eq("user_id", u)  (array)
//   hasAchievement:           .select("id").eq(u).eq(key).limit(1)  (array)
function makeAchievementsChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(col1: string, val1: any) {
          const byUser = () => achievements.filter(a => a.user_id === val1);
          return {
            // getUnlockedAchievements awaits .eq(user) directly.
            then: (resolve: any) => resolve({ data: byUser().map(a => ({ achievement_key: a.achievement_key, unlocked_at: a.unlocked_at })), error: null }),
            // hasAchievement: .eq(user).eq(key).limit(1)
            eq(_col2: string, val2: any) {
              const matched = byUser().filter(a => a.achievement_key === val2);
              return { limit: (_n: number) => ({ then: (resolve: any) => resolve({ data: matched.map(a => ({ id: a.id })), error: null }) }) };
            },
          };
        },
      };
    },
    insert(row: any) {
      // Unique (user_id, achievement_key) — second insert returns an error.
      const dup = achievements.some(a => a.user_id === row.user_id && a.achievement_key === row.achievement_key);
      if (dup) return Promise.resolve({ data: null, error: { message: "duplicate key value violates unique constraint" } });
      achievements.push({ id: achSeq++, user_id: row.user_id, achievement_key: row.achievement_key, unlocked_at: new Date().toISOString() });
      return Promise.resolve({ data: null, error: null });
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
      if (table === "eris_shop_items") return makeShopChain();
      if (table === "eris_inventory") return makeInventoryChain();
      if (table === "eris_achievements") return makeAchievementsChain();
      return makeNoopChain();
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

let db: any;

beforeEach(async () => {
  shop.clear();
  inventory = [];
  invSeq = 1;
  achievements = [];
  achSeq = 1;
  shopReadError = null;
  shopWriteError = null;
  stealNextUpdates = 0;
  vi.resetModules();
  db = await import("../../database.js");
  await db.initDatabase();
});

describe("inventory.js — atomic shop stock", () => {
  it("tryDecrementShopStock decrements a limited item and returns remaining", async () => {
    shop.set("s1", { id: "s1", guild_id: "g1", limited_stock: 3 });
    const res = await db.tryDecrementShopStock("s1");
    expect(res).toEqual({ ok: true, remaining: 2 });
    expect(shop.get("s1")!.limited_stock).toBe(2);
  });

  it("treats null limited_stock as unlimited (no write, remaining=null)", async () => {
    shop.set("s2", { id: "s2", guild_id: null, limited_stock: null });
    const res = await db.tryDecrementShopStock("s2");
    expect(res).toEqual({ ok: true, remaining: null });
  });

  it("returns sold_out when stock is already 0", async () => {
    shop.set("s3", { id: "s3", guild_id: "g1", limited_stock: 0 });
    const res = await db.tryDecrementShopStock("s3");
    expect(res).toEqual({ ok: false, reason: "sold_out" });
    expect(shop.get("s3")!.limited_stock).toBe(0);
  });

  it("surfaces a read error verbatim", async () => {
    shop.set("s4", { id: "s4", guild_id: "g1", limited_stock: 5 });
    shopReadError = { message: "boom-read" };
    const res = await db.tryDecrementShopStock("s4");
    expect(res).toEqual({ ok: false, reason: "boom-read" });
  });

  it("surfaces a write error verbatim", async () => {
    shop.set("s5", { id: "s5", guild_id: "g1", limited_stock: 5 });
    shopWriteError = { message: "boom-write" };
    const res = await db.tryDecrementShopStock("s5");
    expect(res).toEqual({ ok: false, reason: "boom-write" });
  });

  it("retries on an optimistic conflict and eventually succeeds", async () => {
    shop.set("s6", { id: "s6", guild_id: "g1", limited_stock: 4 });
    // First attempt loses the race (guard bumped); second attempt re-reads & wins.
    stealNextUpdates = 1;
    const res = await db.tryDecrementShopStock("s6");
    expect(res.ok).toBe(true);
    // The competing writer bumped stock by 1 (4→5), then we decrement once (5→4).
    expect(typeof res.remaining).toBe("number");
  });

  it("gives up after 3 conflicting attempts (stock_changed_retry_exhausted)", async () => {
    shop.set("s7", { id: "s7", guild_id: "g1", limited_stock: 4 });
    stealNextUpdates = 5; // all attempts lose the race
    const res = await db.tryDecrementShopStock("s7");
    expect(res).toEqual({ ok: false, reason: "stock_changed_retry_exhausted" });
  });

  it("decrementShopStock wrapper forwards to the atomic version and ignores result", async () => {
    shop.set("s8", { id: "s8", guild_id: "g1", limited_stock: 2 });
    await expect(db.decrementShopStock("s8")).resolves.toBeUndefined();
    expect(shop.get("s8")!.limited_stock).toBe(1);
  });

  it("tryIncrementShopStock increments a limited item back up", async () => {
    shop.set("s9", { id: "s9", guild_id: "g1", limited_stock: 1 });
    const res = await db.tryIncrementShopStock("s9");
    expect(res).toEqual({ ok: true, remaining: 2 });
    expect(shop.get("s9")!.limited_stock).toBe(2);
  });

  it("tryIncrementShopStock is a no-op for unlimited items", async () => {
    shop.set("s10", { id: "s10", guild_id: "g1", limited_stock: null });
    const res = await db.tryIncrementShopStock("s10");
    expect(res).toEqual({ ok: true, remaining: null });
  });

  it("tryIncrementShopStock surfaces read + write errors", async () => {
    shop.set("s11", { id: "s11", guild_id: "g1", limited_stock: 1 });
    shopReadError = { message: "inc-read" };
    expect(await db.tryIncrementShopStock("s11")).toEqual({ ok: false, reason: "inc-read" });
    shopReadError = null;
    shopWriteError = { message: "inc-write" };
    expect(await db.tryIncrementShopStock("s11")).toEqual({ ok: false, reason: "inc-write" });
  });
});

describe("inventory.js — shop catalog & item CRUD", () => {
  it("getShopItems returns items ordered by price", async () => {
    shop.set("a", { id: "a", guild_id: "g1", price: 300, limited_stock: null });
    shop.set("b", { id: "b", guild_id: "g1", price: 100, limited_stock: null });
    shop.set("c", { id: "c", guild_id: null, price: 200, limited_stock: null });
    const items = await db.getShopItems("g1");
    expect(items.map((i: ShopRow) => i.price)).toEqual([100, 200, 300]);
  });

  it("addToInventory then getInventory round-trips an item", async () => {
    await db.addToInventory("u1", "Fishing Rod", "equipment");
    const inv = await db.getInventory("u1");
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ user_id: "u1", item_name: "Fishing Rod", item_type: "equipment" });
  });

  it("hasItem reflects presence/absence", async () => {
    await db.addToInventory("u2", "Padlock", "passive");
    expect(await db.hasItem("u2", "Padlock")).toBe(true);
    expect(await db.hasItem("u2", "Nope")).toBe(false);
    expect(await db.hasItem("other", "Padlock")).toBe(false);
  });

  it("removeFromInventory removes one row and returns its item_type", async () => {
    await db.addToInventory("u3", "Mystery Box", "mystery");
    const type = await db.removeFromInventory("u3", "Mystery Box");
    expect(type).toBe("mystery");
    expect(await db.getInventory("u3")).toHaveLength(0);
  });

  it("removeFromInventory returns null when the item is absent", async () => {
    const type = await db.removeFromInventory("u4", "Ghost Item");
    expect(type).toBeNull();
  });
});

describe("inventory.js — achievements", () => {
  it("unlockAchievement returns true the first time, false on the duplicate", async () => {
    expect(await db.unlockAchievement("u5", "first_bet")).toBe(true);
    expect(await db.unlockAchievement("u5", "first_bet")).toBe(false);
  });

  it("hasAchievement / getUnlockedAchievements reflect unlocked keys", async () => {
    await db.unlockAchievement("u6", "rich");
    await db.unlockAchievement("u6", "broke");
    expect(await db.hasAchievement("u6", "rich")).toBe(true);
    expect(await db.hasAchievement("u6", "mega_rich")).toBe(false);
    const unlocked = await db.getUnlockedAchievements("u6");
    expect(unlocked.map((a: AchRow) => a.achievement_key).sort()).toEqual(["broke", "rich"]);
  });
});
