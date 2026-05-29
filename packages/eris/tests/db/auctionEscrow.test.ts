import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported. vi.hoisted() runs before any
// import statement, so config.supabaseEnabled sees these on first read.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// In-memory stores the mock client reads/writes against. The real
// bidOnAuction (with its escrow-on-bid + withEconLock + withAuctionLock) runs
// unmocked, so the actual money flow is what's under test.
type EconRow = { user_id: string; balance: number; version: number; total_earned: number; total_lost: number; total_gambled: number };
type AuctionRow = { id: string; status: string; current_bid: number; current_bidder_id: string | null; seller_id: string; item_name: string };
type InvRow = { user_id: string; item_name: string; item_type: string };

const econ: Map<string, EconRow> = new Map();
const auctions: Map<string, AuctionRow> = new Map();
const inventory: InvRow[] = [];

let yieldDelayMs = 1;
function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

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
          };
        },
      };
    },
    update(updates: Partial<AuctionRow>) {
      return {
        eq(col1: string, val1: any) {
          return {
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
        },
      };
    },
  };
}

function makeInventoryChain() {
  return {
    insert(row: InvRow) { inventory.push({ ...row }); return Promise.resolve({ data: null, error: null }); },
  };
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "eris_economy") return makeEconChain();
      if (table === "eris_auctions") return makeAuctionChain();
      if (table === "eris_inventory") return makeInventoryChain();
      return makeNoopChain();
    },
    // Force the CAS fallback so the deterministic, mockable path is exercised.
    rpc(_name: string, _args: any) {
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

// Import AFTER mocks.
// @ts-expect-error - importing JS module without types
import { initDatabase, bidOnAuction, getBalance, updateBalance, addToInventory } from "../../database.js";

function seedEcon(userId: string, balance: number) {
  econ.set(userId, { user_id: userId, balance, version: 0, total_earned: 0, total_lost: 0, total_gambled: 0 });
}

function totalCoins() {
  let sum = 0;
  for (const row of econ.values()) sum += row.balance;
  return sum;
}

describe("auction escrow-on-bid — net coin creation is zero", () => {
  beforeEach(async () => {
    econ.clear();
    auctions.clear();
    inventory.length = 0;
    yieldDelayMs = 1;
    await initDatabase();
  });

  it("a full auction (bid → outbid → settle) conserves coins exactly", async () => {
    const seller = "seller-1";
    const bidderA = "bidderA";
    const bidderB = "bidderB";
    seedEcon(seller, 0);
    seedEcon(bidderA, 1000);
    seedEcon(bidderB, 1000);

    const auctionId = "auction-x";
    auctions.set(auctionId, {
      id: auctionId,
      status: "active",
      current_bid: 50,          // starting price — NOT an escrowed bid
      current_bidder_id: null,  // no real bidder yet
      seller_id: seller,
      item_name: "Cursed Idol",
    });

    const startTotal = totalCoins();

    // bidderA bids 100 — escrowed from their wallet.
    const a = await bidOnAuction(auctionId, bidderA, 100);
    expect(a).toBe(true);
    expect((await getBalance(bidderA)).balance).toBe(900); // 100 escrowed

    // bidderB outbids at 250 — escrowed from B, A refunded their 100.
    const b = await bidOnAuction(auctionId, bidderB, 250);
    expect(b).toBe(true);
    expect((await getBalance(bidderB)).balance).toBe(750); // 250 escrowed
    expect((await getBalance(bidderA)).balance).toBe(1000); // fully refunded

    // While the bid is escrowed, the only coins "missing" from wallets are the
    // current_bid held in escrow — wallets + escrow == the starting total.
    const escrowed = auctions.get(auctionId)!.current_bid;
    expect(totalCoins() + escrowed).toBe(startTotal);

    // Settlement (mirrors events/ready.js): credit seller the escrowed winning
    // bid + grant the item to the winner.
    const final = auctions.get(auctionId)!;
    await updateBalance(final.seller_id, final.current_bid, "auction_sale", final.item_name);
    await addToInventory(final.current_bidder_id!, final.item_name, "auction");

    // Seller got the winning bid; winner spent it; net coins unchanged.
    expect((await getBalance(seller)).balance).toBe(250);
    expect((await getBalance(bidderB)).balance).toBe(750);
    expect(totalCoins()).toBe(startTotal);
    expect(inventory).toContainEqual({ user_id: bidderB, item_name: "Cursed Idol", item_type: "auction" });
  });

  it("a bidder who cannot pay is rejected and no coins move", async () => {
    const seller = "seller-2";
    const broke = "broke-bidder";
    seedEcon(seller, 0);
    seedEcon(broke, 30); // can't cover a 100 bid

    const auctionId = "auction-y";
    auctions.set(auctionId, {
      id: auctionId,
      status: "active",
      current_bid: 50,
      current_bidder_id: null,
      seller_id: seller,
      item_name: "Trinket",
    });

    const startTotal = totalCoins();
    const result = await bidOnAuction(auctionId, broke, 100);
    expect(result).toBe(false);
    // Bid rejected: nothing escrowed, auction unchanged, coins conserved.
    expect((await getBalance(broke)).balance).toBe(30);
    expect(auctions.get(auctionId)!.current_bidder_id).toBeNull();
    expect(totalCoins()).toBe(startTotal);
  });
});
