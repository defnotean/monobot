import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Exercises database/activities.js pet hunger-decay + feed/train read-modify-
// write logic and the loan helpers, plus database/crafting.js. The decay math
// (_applyHungerDecay) is private, so it's covered indirectly through getPet /
// feedPet. withEconLock wraps the pet mutations; the mock client makes those
// deterministic.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

type PetRow = { user_id: string; name: string; species: string; hunger?: number; mood?: number; xp?: number; attack?: number; defense?: number; speed?: number; last_fed?: string };
type LoanRow = { id: number; user_id: string; amount: number; interest_rate: number; due_at: string; status: string };
type RecipeRow = { user_id: string; recipe_name: string; discovered_at: string };

let pets: PetRow[] = [];
let loans: LoanRow[] = [];
let loanSeq = 1;
let recipes: RecipeRow[] = [];
let recipeUpsertError = false;

function petChain() {
  return {
    select(_c = "*") {
      return {
        eq(_col: string, val: any) {
          return { async single() { const p = pets.find(p => p.user_id === val); return { data: p ? { ...p } : null, error: null }; } };
        },
      };
    },
    insert(row: any) {
      const full: PetRow = { ...row };
      pets.push(full);
      return { select: () => ({ async single() { return { data: { ...full }, error: null }; } }) };
    },
    update(updates: any) {
      return {
        eq(_col: string, val: any) {
          const p = pets.find(p => p.user_id === val);
          if (p) Object.assign(p, updates);
          return { then: (resolve: any) => resolve({ data: null, error: null }) };
        },
      };
    },
  };
}

function loanChain() {
  return {
    insert(row: any) {
      loans.push({ id: loanSeq++, user_id: row.user_id, amount: row.amount, interest_rate: row.interest_rate, due_at: row.due_at, status: row.status ?? "active" });
      return Promise.resolve({ data: null, error: null });
    },
    select(_c = "*") {
      return {
        eq(col1: string, val1: any) {
          return {
            // getActiveLoan: .eq(user).eq("status","active").limit(1).single()
            eq(col2: string, val2: any) {
              const matched = loans.filter(l => (l as any)[col1] === val1 && (l as any)[col2] === val2);
              return {
                limit: (_n: number) => ({ async single() { return { data: matched[0] ? { ...matched[0] } : null, error: null }; } }),
              };
            },
            // getOverdueLoans: .select("*").eq("status","active").lt("due_at", now)
            lt(_c: string, v: any) {
              const overdue = loans.filter(l => (l as any)[col1] === val1 && new Date(l.due_at).getTime() < new Date(v).getTime());
              return { then: (resolve: any) => resolve({ data: overdue.map(l => ({ ...l })), error: null }) };
            },
          };
        },
      };
    },
    update(updates: any) {
      return {
        eq(_col: string, val: any) {
          const l = loans.find(l => l.id === val);
          if (l) Object.assign(l, updates);
          return { then: (resolve: any) => resolve({ data: null, error: null }) };
        },
      };
    },
  };
}

function recipeChain() {
  return {
    select(_c = "*") {
      return { eq(_col: string, val: any) { const rows = recipes.filter(r => r.user_id === val).map(r => ({ ...r })); return { then: (resolve: any) => resolve({ data: rows, error: null }) }; } };
    },
    upsert(row: any) {
      if (recipeUpsertError) return Promise.reject(new Error("upsert blew up"));
      const idx = recipes.findIndex(r => r.user_id === row.user_id && r.recipe_name === row.recipe_name);
      if (idx >= 0) recipes[idx] = { ...recipes[idx], ...row };
      else recipes.push({ user_id: row.user_id, recipe_name: row.recipe_name, discovered_at: row.discovered_at });
      return Promise.resolve({ data: null, error: null });
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
      if (table === "eris_pets") return petChain();
      if (table === "eris_loans") return loanChain();
      if (table === "eris_recipes") return recipeChain();
      return makeNoopChain();
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

let db: any;

beforeEach(async () => {
  pets = [];
  loans = [];
  loanSeq = 1;
  recipes = [];
  recipeUpsertError = false;
  vi.resetModules();
  vi.useRealTimers();
  db = await import("../../database.js");
  await db.initDatabase();
});

afterEach(() => vi.useRealTimers());

describe("activities.js — pet hunger decay (via getPet)", () => {
  it("returns null when the user has no pet", async () => {
    expect(await db.getPet("nopet")).toBeNull();
  });

  it("does not decay a pet fed just now", async () => {
    // Pin the clock so the source's Date.now() and our last_fed timestamp agree
    // to the millisecond → hoursPassed === 0 → no decay. Without this the slow
    // coverage run lets real time elapse and Math.floor(hoursPassed*2) can tick to 1.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    pets.push({ user_id: "u1", name: "Rex", species: "dog", hunger: 80, mood: 90, last_fed: new Date().toISOString() });
    const pet = await db.getPet("u1");
    expect(pet.hunger).toBe(80);
    expect(pet.mood).toBe(90);
    vi.useRealTimers();
  });

  it("decays hunger ~2/hour over elapsed time", async () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
    pets.push({ user_id: "u2", name: "Rex", species: "dog", hunger: 100, mood: 100, last_fed: tenHoursAgo });
    const pet = await db.getPet("u2");
    // 10h * 2 = 20 hunger lost → 80. Pet started well-fed (>=50) so mood drifts up but clamps at 100.
    expect(pet.hunger).toBe(80);
    expect(pet.mood).toBe(100);
  });

  it("hangry pets (hunger<=30) lose mood instead of gaining it", async () => {
    const fortyHoursAgo = new Date(Date.now() - 40 * 3_600_000).toISOString();
    pets.push({ user_id: "u3", name: "Rex", species: "cat", hunger: 50, mood: 100, last_fed: fortyHoursAgo });
    const pet = await db.getPet("u3");
    // 40h*2 = 80 → hunger 0 (<=30) so mood decays by 40h*1 = 40 → 60.
    expect(pet.hunger).toBe(0);
    expect(pet.mood).toBe(60);
  });

  it("clamps a future last_fed (clock skew) so decay never goes negative", async () => {
    const future = new Date(Date.now() + 1_000 * 3_600_000).toISOString();
    pets.push({ user_id: "u4", name: "Rex", species: "dog", hunger: 75, mood: 75, last_fed: future });
    const pet = await db.getPet("u4");
    // Future timestamp clamps to now → no decay.
    expect(pet.hunger).toBe(75);
    expect(pet.mood).toBe(75);
  });
});

describe("activities.js — feedPet & trainPet (read-modify-write)", () => {
  it("feedPet returns null when there's no pet", async () => {
    expect(await db.feedPet("ghost")).toBeNull();
  });

  it("feedPet adds hunger/mood/xp on the decayed-forward baseline", async () => {
    pets.push({ user_id: "f1", name: "Rex", species: "dog", hunger: 50, mood: 50, xp: 0, last_fed: new Date().toISOString() });
    const res = await db.feedPet("f1");
    expect(res.hunger).toBe(80); // 50 + 30
    expect(res.mood).toBe(60); // 50 + 10
    expect(res.xp).toBe(5); // 0 + 5
    // Persisted row updated too.
    expect(pets.find(p => p.user_id === "f1")!.hunger).toBe(80);
  });

  it("feedPet caps hunger/mood at 100", async () => {
    pets.push({ user_id: "f2", name: "Rex", species: "dog", hunger: 95, mood: 95, xp: 1, last_fed: new Date().toISOString() });
    const res = await db.feedPet("f2");
    expect(res.hunger).toBe(100);
    expect(res.mood).toBe(100);
  });

  it("trainPet rejects an invalid stat", async () => {
    pets.push({ user_id: "t0", name: "Rex", species: "dog", attack: 5, last_fed: new Date().toISOString() });
    expect(await db.trainPet("t0", "charisma")).toBeNull();
  });

  it("trainPet returns null when there's no pet", async () => {
    expect(await db.trainPet("t-ghost", "attack")).toBeNull();
  });

  it("trainPet increments a valid stat by +1..+3", async () => {
    pets.push({ user_id: "t1", name: "Rex", species: "dog", attack: 5, last_fed: new Date().toISOString() });
    vi.spyOn(Math, "random").mockReturnValue(0); // gain = 1 + floor(0*3) = 1
    const res = await db.trainPet("t1", "attack");
    expect(res).toEqual({ stat: "attack", gain: 1, newValue: 6 });
    expect(pets.find(p => p.user_id === "t1")!.attack).toBe(6);
    vi.restoreAllMocks();
  });

  it("trainPet defaults a missing stat baseline to 5", async () => {
    pets.push({ user_id: "t2", name: "Rex", species: "dog", last_fed: new Date().toISOString() });
    vi.spyOn(Math, "random").mockReturnValue(0.99); // gain = 1 + floor(0.99*3) = 3
    const res = await db.trainPet("t2", "speed");
    expect(res.gain).toBe(3);
    expect(res.newValue).toBe(8); // 5 baseline + 3
    vi.restoreAllMocks();
  });
});

describe("activities.js — loans", () => {
  it("createLoan then getActiveLoan returns the active loan", async () => {
    await db.createLoan("L1", 1000, 0.1, new Date(Date.now() + 3_600_000).toISOString());
    const loan = await db.getActiveLoan("L1");
    expect(loan).toMatchObject({ user_id: "L1", amount: 1000, status: "active" });
  });

  it("getActiveLoan returns null when the user has none", async () => {
    expect(await db.getActiveLoan("L-none")).toBeNull();
  });

  it("closeLoan flips status off active so getActiveLoan stops returning it", async () => {
    await db.createLoan("L2", 500, 0.05, new Date(Date.now() + 3_600_000).toISOString());
    const loan = await db.getActiveLoan("L2");
    await db.closeLoan(loan.id, "paid");
    expect(loans.find(l => l.id === loan.id)!.status).toBe("paid");
    expect(await db.getActiveLoan("L2")).toBeNull();
  });

  it("getOverdueLoans returns only active loans past due", async () => {
    await db.createLoan("L3", 200, 0.1, new Date(Date.now() - 3_600_000).toISOString()); // overdue
    await db.createLoan("L4", 300, 0.1, new Date(Date.now() + 3_600_000).toISOString()); // future
    const overdue = await db.getOverdueLoans();
    expect(overdue.map((l: LoanRow) => l.user_id)).toEqual(["L3"]);
  });
});

describe("crafting.js — discovered recipes", () => {
  it("getDiscoveredRecipes is [] for a fresh user, then reflects an add", async () => {
    expect(await db.getDiscoveredRecipes("c1")).toEqual([]);
    await db.addDiscoveredRecipe("c1", "Iron Sword");
    const recs = await db.getDiscoveredRecipes("c1");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ user_id: "c1", recipe_name: "Iron Sword" });
  });

  it("addDiscoveredRecipe upserts idempotently (no duplicate rows)", async () => {
    await db.addDiscoveredRecipe("c2", "Health Potion");
    await db.addDiscoveredRecipe("c2", "Health Potion");
    expect(await db.getDiscoveredRecipes("c2")).toHaveLength(1);
  });

  it("addDiscoveredRecipe swallows an upsert error (logs, does not throw)", async () => {
    recipeUpsertError = true;
    await expect(db.addDiscoveredRecipe("c3", "Cursed Blade")).resolves.toBeUndefined();
  });
});
