import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported. vi.hoisted() runs before any
// import statement, so config.supabaseEnabled sees these on first read.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// In-memory store the mock client reads/writes against.
type AuctionRow = {
  id: string;
  status: string;
  current_bid: number;
  current_bidder_id: string | null;
};
const auctions: Map<string, AuctionRow> = new Map();

// Tunable: how long select/update yield the event loop. Forcing both calls
// through real awaits ensures the read-modify-write window is wide enough
// that without locking, two concurrent bids interleave their phases.
let yieldDelayMs = 1;

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table !== "eris_auctions") {
        // Other tables — return a no-op chainable so init/load doesn't crash.
        return makeNoopChain();
      }
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
                      // Optimistic concurrency check — only mutate if the
                      // guarded column still equals the value we read.
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
    },
  };
}

function makeNoopChain(): any {
  // Build a chain object whose every method returns the same chain, EXCEPT
  // .single() (returns a resolved promise) and `then` (so awaiting the chain
  // itself resolves cleanly without recursing through the proxy on `then`).
  const chain: any = {};
  const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
    "order", "limit", "insert", "upsert", "update", "delete", "from"];
  for (const m of methods) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeMockSupabase(),
}));

// Import AFTER mocks are set up.
// @ts-expect-error - importing JS module without types
import { initDatabase, bidOnAuction } from "../../database.js";

describe("bidOnAuction concurrency", () => {
  beforeEach(async () => {
    auctions.clear();
    await initDatabase();
  });

  it("higher bid wins when two concurrent bids race on the same auction", async () => {
    const auctionId = "auction-1";
    auctions.set(auctionId, {
      id: auctionId,
      status: "active",
      current_bid: 50,
      current_bidder_id: "seller",
    });

    const [resultA, resultB] = await Promise.all([
      bidOnAuction(auctionId, "userA", 100),
      bidOnAuction(auctionId, "userB", 200),
    ]);

    const final = auctions.get(auctionId)!;
    // The higher bid (200 by userB) MUST be the final winner.
    expect(final.current_bid).toBe(200);
    expect(final.current_bidder_id).toBe("userB");

    // Both bids beat the 50 starting bid, so both can return true depending on
    // ordering — but if userA acquired the lock first (committed at 100),
    // userB's bid of 200 then wins on its turn. If userB went first (200),
    // userA's later bid of 100 must be REJECTED because 100 ≤ 200.
    // The invariant: at least one returns true, and whichever is the higher
    // bid won the auction.
    expect(resultA === true || resultB === true).toBe(true);
    if (resultA && resultB) {
      // userA bid first inside the lock (100 accepted), then userB (200 also accepted).
      // Both returned true, final is 200. OK.
      expect(final.current_bid).toBe(200);
    } else if (resultB && !resultA) {
      // userB bid first (200), userA's later 100 was rejected. Correct.
      expect(final.current_bid).toBe(200);
    }
  });

  it("losing bidder is rejected (returns false) — second-place bid does not silently overwrite", async () => {
    const auctionId = "auction-2";
    auctions.set(auctionId, {
      id: auctionId,
      status: "active",
      current_bid: 100,
      current_bidder_id: "seller",
    });

    // userA bids 150, userB bids 120 — userB MUST lose since 120 < 150.
    // The race-bug version could let userB's update overwrite userA's.
    const results = await Promise.all([
      bidOnAuction(auctionId, "userA", 150),
      bidOnAuction(auctionId, "userB", 120),
    ]);

    const final = auctions.get(auctionId)!;
    expect(final.current_bid).toBe(150);
    expect(final.current_bidder_id).toBe("userA");

    // userA always wins its bid; userB might win temporarily then get
    // out-bid, OR be rejected. Either way the final state must be userA@150.
    // userA must have returned true at some point.
    expect(results[0]).toBe(true);
  });

  it("rejects bid below current_bid even under concurrency", async () => {
    const auctionId = "auction-3";
    auctions.set(auctionId, {
      id: auctionId,
      status: "active",
      current_bid: 500,
      current_bidder_id: "seller",
    });

    const result = await bidOnAuction(auctionId, "lowballer", 100);
    expect(result).toBe(false);
    expect(auctions.get(auctionId)!.current_bid).toBe(500);
  });

  it("optimistic concurrency check rejects stale write across simulated multi-instance", async () => {
    // Simulate the cross-instance case: another writer mutates current_bid
    // between our read and our update. With the .eq("current_bid", lastSeen)
    // guard, our update should match zero rows on attempt 1, then re-read and
    // either succeed at the new price or reject if our amount is no longer
    // higher.
    const auctionId = "auction-4";
    auctions.set(auctionId, {
      id: auctionId,
      status: "active",
      current_bid: 100,
      current_bidder_id: "seller",
    });

    // Hijack: increase yieldDelayMs so we can sneak in an out-of-band update.
    yieldDelayMs = 20;
    const bidPromise = bidOnAuction(auctionId, "raceWinner", 250);
    // While bidOnAuction is mid-flight (it will await the select first),
    // simulate an external writer raising current_bid to 200.
    await delay(5);
    const row = auctions.get(auctionId)!;
    row.current_bid = 200;
    row.current_bidder_id = "external";
    const result = await bidPromise;
    yieldDelayMs = 1;

    // raceWinner bid 250, external moved it to 200 mid-flight. After the
    // optimistic-fail retry, raceWinner re-reads and wins at 250.
    expect(result).toBe(true);
    expect(auctions.get(auctionId)!.current_bid).toBe(250);
    expect(auctions.get(auctionId)!.current_bidder_id).toBe("raceWinner");
  });
});
