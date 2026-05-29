import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported. vi.hoisted() runs before any
// import statement, so config.supabaseEnabled sees these on first read.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// Real database.js (createAuction / bidOnAuction / closeExpiredAuctions /
// updateMood / flushAll / isPersistenceHealthy) runs unmocked against this
// in-memory store. Covers:
//   (b) creating then settling an auction leaves exactly one copy of the item
//   (c) a bidder raising their own bid ends with total escrow == current bid
//   (d) N consecutive flush failures refuse economy writes; a success re-enables
type EconRow = { user_id: string; balance: number; version: number; total_earned: number; total_lost: number; total_gambled: number };
type AuctionRow = { id: string; status: string; current_bid: number; current_bidder_id: string | null; seller_id: string; item_name: string; starting_price: number; ends_at: string; guild_id: string };
type InvRow = { id: number; user_id: string; item_name: string; item_type: string };

const econ: Map<string, EconRow> = new Map();
const auctions: Map<string, AuctionRow> = new Map();
let inventory: InvRow[] = [];
let invSeq = 1;
let auctionSeq = 1;

// When true, the debounced-flush upserts (mood / relationships / bot_data) all
// reject — simulating the durable store being unreachable.
let failFlush = false;

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
const yieldDelayMs = 1;

function makeNoopChain(): any {
  const chain: any = {};
  const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
    "order", "limit", "insert", "upsert", "update", "delete", "from"];
  for (const m of methods) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

// Flushable buckets (mood / relationships / bot_data). upsert resolves unless
// failFlush is set, in which case it rejects to count as a flush failure.
function makeFlushChain() {
  const chain: any = makeNoopChain();
  chain.upsert = (_row: any) => failFlush
    ? Promise.reject(new Error("simulated durable store unreachable"))
    : Promise.resolve({ data: null, error: null });
  return chain;
}

function makeEconChain() {
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
    insert(_row: any) { return Promise.resolve({ data: null, error: null }); },
  };
}

function makeAuctionChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(col: string, val: any) {
          return {
            async single() {
              await delay(yieldDelayMs);
              if (col !== "id") return { data: null, error: null };
              const row = auctions.get(val);
              return { data: row ? { ...row } : null, error: null };
            },
            // closeExpiredAuctions: .select("*").eq("status","active").lt("ends_at", now)
            lt(_c: string, _v: any) {
              return {
                async then(resolve: any) {
                  const now = Date.now();
                  const rows = [...auctions.values()].filter(
                    (a) => a.status === "active" && new Date(a.ends_at).getTime() < now,
                  );
                  return resolve({ data: rows.map((r) => ({ ...r })), error: null });
                },
              };
            },
          };
        },
      };
    },
    insert(row: any) {
      return {
        select() {
          return {
            async single() {
              const id = `auction-${auctionSeq++}`;
              const full: AuctionRow = { id, status: "active", current_bidder_id: null, ...row } as AuctionRow;
              auctions.set(id, full);
              return { data: { ...full }, error: null };
            },
          };
        },
      };
    },
    update(updates: Partial<AuctionRow>) {
      return {
        eq(col1: string, val1: any) {
          const firstEq: any = {
            // closeExpiredAuctions: .update({status}).eq("id", id) — awaited directly.
            then(resolve: any) {
              const row = auctions.get(val1);
              if (row) Object.assign(row, updates);
              return resolve({ data: null, error: null });
            },
            // bidOnAuction: .update({...}).eq("id").eq("current_bid", lastSeen).select()
            eq(col2: string, val2: any) {
              return {
                async select() {
                  await delay(yieldDelayMs);
                  const row = auctions.get(val1);
                  if (!row) return { data: [], error: null };
                  if ((row as any)[col2] !== val2) return { data: [], error: null };
                  Object.assign(row, updates);
                  return { data: [{ ...row }], error: null };
                },
              };
            },
          };
          return firstEq;
        },
      };
    },
  };
}

// Inventory chain: tracks real rows so we can count copies.
//   hasItem:            .select("id").eq(user).eq(item).limit(1)        → array
//   removeFromInventory:.select("id").eq(user).eq(item).limit(1).single + .delete().eq("id")
//   addToInventory:     .insert({...})
//   getInventory:       .select("*").eq(user).order(...)
function makeInventoryChain() {
  return {
    select(_cols: string = "*") {
      return {
        eq(col1: string, val1: any) {
          const matchOne = (item: string) => inventory.filter((r) => r.user_id === val1 && r.item_name === item);
          return {
            eq(_col2: string, val2: any) {
              const rows = matchOne(val2);
              return {
                // hasItem awaits .limit(1) directly (array of {id}).
                // removeFromInventory selects "id, item_type" and chains .single().
                limit(_n: number) {
                  const limited = rows.slice(0, 1).map((r) => ({ id: r.id, item_type: r.item_type }));
                  const thenable: any = {
                    then(resolve: any) { return resolve({ data: limited, error: null }); },
                    async single() { return { data: limited[0] || null, error: null }; },
                  };
                  return thenable;
                },
              };
            },
            // getInventory: .eq(user).order(...) → all rows for user.
            order(_c: string, _o: any) {
              const rows = inventory.filter((r) => r.user_id === val1).map((r) => ({ ...r }));
              return { then(resolve: any) { return resolve({ data: rows, error: null }); } };
            },
          };
        },
      };
    },
    insert(row: any) {
      inventory.push({ id: invSeq++, user_id: row.user_id, item_name: row.item_name, item_type: row.item_type });
      return Promise.resolve({ data: null, error: null });
    },
    delete() {
      return {
        eq(_col: string, val: any) {
          const idx = inventory.findIndex((r) => r.id === val);
          if (idx >= 0) inventory.splice(idx, 1);
          return { then(resolve: any) { return resolve({ data: null, error: null }); } };
        },
      };
    },
  };
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "eris_economy") return makeEconChain();
      if (table === "eris_auctions") return makeAuctionChain();
      if (table === "eris_inventory") return makeInventoryChain();
      if (table === "eris_mood" || table === "eris_relationships" || table === "bot_data") return makeFlushChain();
      return makeNoopChain();
    },
    // Force the CAS fallback so the deterministic, mockable economy path runs.
    rpc(_name: string, _args: any) {
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

// Import AFTER mocks.
// @ts-expect-error - importing JS module without types
import {
  initDatabase, getBalance, getInventory, addToInventory,
  createAuction, bidOnAuction, closeExpiredAuctions, updateBalance,
  updateMood, flushAll, isPersistenceHealthy,
} from "../../database.js";

function seedEcon(userId: string, balance: number) {
  econ.set(userId, { user_id: userId, balance, version: 0, total_earned: 0, total_lost: 0, total_gambled: 0 });
}
function totalCoins() {
  let sum = 0;
  for (const row of econ.values()) sum += row.balance;
  return sum;
}

describe("auction item dupe + self-raise escrow + flush durability", () => {
  beforeEach(async () => {
    econ.clear();
    auctions.clear();
    inventory = [];
    invSeq = 1;
    auctionSeq = 1;
    failFlush = false;
    await initDatabase();
    // Recover persistence health from any prior test that left it tripped.
    await flushAll();
  });

  it("(b) creating then settling an auction leaves exactly ONE copy of the item", async () => {
    const seller = "seller-dupe";
    const winner = "winner-dupe";
    seedEcon(seller, 0);
    seedEcon(winner, 5000);
    await addToInventory(seller, "Cursed Idol", "loot");

    // List it — the item is escrowed OUT of the seller's inventory at create time.
    const auction = await createAuction(seller, "Cursed Idol", 100, "g1");
    expect(auction).not.toBeNull();
    expect(await getInventory(seller)).toHaveLength(0); // no longer the seller's

    // Winner bids (escrows coins).
    expect(await bidOnAuction(auction.id, winner, 300)).toBe(true);

    // Settle (mirrors events/ready.js winner-grant path): seller credited the
    // escrowed bid, winner granted the item.
    const row = auctions.get(auction.id)!;
    await updateBalance(row.seller_id, row.current_bid, "auction_sale", row.item_name);
    await addToInventory(row.current_bidder_id!, row.item_name, "auction");

    // Exactly one copy of the item exists, and it's the winner's.
    const sellerInv = await getInventory(seller);
    const winnerInv = await getInventory(winner);
    expect(sellerInv.filter((i: any) => i.item_name === "Cursed Idol")).toHaveLength(0);
    expect(winnerInv.filter((i: any) => i.item_name === "Cursed Idol")).toHaveLength(1);

    // Coins conserved: seller +300, winner -300.
    expect((await getBalance(seller)).balance).toBe(300);
    expect((await getBalance(winner)).balance).toBe(4700);
  });

  it("(b) an auction that expires with no bids refunds the item to the seller", async () => {
    const seller = "seller-nobids";
    seedEcon(seller, 0);
    await addToInventory(seller, "Trinket", "loot");

    // List with a duration already in the past so it's immediately expired.
    const auction = await createAuction(seller, "Trinket", 100, "g1", -1000);
    expect(auction).not.toBeNull();
    expect(await getInventory(seller)).toHaveLength(0);

    const closed = await closeExpiredAuctions();
    expect(closed.some((a: any) => a.id === auction.id)).toBe(true);

    // Item is back with the seller — still exactly one copy total.
    const inv = await getInventory(seller);
    const refunded = inv.filter((i: any) => i.item_name === "Trinket");
    expect(refunded).toHaveLength(1);
    // ...and restored under its ORIGINAL category, not a lifecycle string, so
    // inventoryEmbed groups it correctly (round-trip of the escrowed item_type).
    expect(refunded[0].item_type).toBe("loot");
  });

  it("(b) refuses to list an item the seller does not own", async () => {
    const seller = "seller-noitem";
    seedEcon(seller, 0);
    const auction = await createAuction(seller, "Phantom", 100, "g1");
    expect(auction).toBeNull();
  });

  it("(c) a bidder raising their own bid ends with total escrow == current bid", async () => {
    const seller = "seller-raise";
    const bidder = "self-raiser";
    seedEcon(seller, 0);
    seedEcon(bidder, 1000);
    await addToInventory(seller, "Relic", "loot");

    const auction = await createAuction(seller, "Relic", 50, "g1");
    expect(auction).not.toBeNull();
    const startTotal = totalCoins();

    // First bid: 100 escrowed → wallet 900.
    expect(await bidOnAuction(auction.id, bidder, 100)).toBe(true);
    expect((await getBalance(bidder)).balance).toBe(900);

    // Same bidder raises to 250. Prior 100 escrow must be refunded so they only
    // hold 250 in escrow (not 350). Wallet should be 1000 - 250 = 750.
    expect(await bidOnAuction(auction.id, bidder, 250)).toBe(true);
    const current = auctions.get(auction.id)!.current_bid;
    expect(current).toBe(250);
    expect((await getBalance(bidder)).balance).toBe(750);

    // Total escrow held == current bid: wallets + escrow == starting total.
    expect(totalCoins() + current).toBe(startTotal);
  });

  it("(d) N consecutive flush failures refuse economy writes; a success re-enables them", async () => {
    const userId = "durability-user";
    seedEcon(userId, 500);

    // Healthy baseline.
    expect(isPersistenceHealthy()).toBe(true);

    // Simulate the durable store going dark, then drive flush cycles.
    failFlush = true;
    for (let i = 0; i < 5; i++) {
      updateMood(i, 50);     // marks a bucket dirty
      await flushAll();      // one failed flush cycle (all upserts reject)
    }

    // Threshold (5) reached — economy-mutating writes must now refuse.
    expect(isPersistenceHealthy()).toBe(false);
    await expect(updateBalance(userId, 100, "test", "should refuse"))
      .rejects.toThrow(/persistence temporarily unavailable/);
    // Balance untouched — the write was refused, not applied.
    expect((await getBalance(userId)).balance).toBe(500);

    // Durable store recovers; one successful flush re-enables writes.
    failFlush = false;
    updateMood(99, 50);
    await flushAll();
    expect(isPersistenceHealthy()).toBe(true);

    const newBal = await updateBalance(userId, 100, "test", "now allowed");
    expect(newBal).toBe(600);
    expect((await getBalance(userId)).balance).toBe(600);
  });

  it("(d) reads keep working from cache while persistence is unhealthy", async () => {
    const userId = "read-during-outage";
    seedEcon(userId, 777);
    // Warm the cache.
    expect((await getBalance(userId)).balance).toBe(777);

    failFlush = true;
    for (let i = 0; i < 5; i++) { updateMood(i, 50); await flushAll(); }
    expect(isPersistenceHealthy()).toBe(false);

    // Read still answers (from cache / store) even though writes are refused.
    expect((await getBalance(userId)).balance).toBe(777);
  });
});
