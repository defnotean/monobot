import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported. vi.hoisted() runs before any
// import statement, so config.supabaseEnabled sees these on first read.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// In-memory state the mock db reads/writes.
type State = {
  balance: number;
  pet: { attack: number; defense: number; speed: number } | null;
  trainCalls: number;
  balanceUpdateCalls: number;
  totalDeducted: number;
};

const state: State = {
  balance: 1000,
  pet: { attack: 5, defense: 5, speed: 5 },
  trainCalls: 0,
  balanceUpdateCalls: 0,
  totalDeducted: 0,
};

// Mock supabase module so config.supabaseEnabled is true and database.js can
// import without trying to talk to a real backend. Other table reads short-
// circuit through the noop chain.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from() {
      const chain: any = {};
      const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
        "order", "limit", "insert", "upsert", "update", "delete", "from"];
      for (const m of methods) chain[m] = () => chain;
      chain.single = async () => ({ data: null, error: null });
      chain.then = (resolve: any) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

// Force a small async yield inside the train pipeline so two parallel calls
// definitely interleave through the read-check-write window.
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Mock the database module. We import the real `tryAcquireCooldown` /
// `setCooldown` / `checkCooldown` so the cooldown semantics under test are
// the real ones — but stub everything else the executor pulls from db.
vi.mock("../../database.js", async () => {
  const real = (await vi.importActual<any>("../../database.js"));
  return {
    ...real,
    tryAcquireCooldown: real.tryAcquireCooldown,
    checkCooldown: real.checkCooldown,
    setCooldown: real.setCooldown,
    async getBalance(_userId: string) {
      await delay(2);
      return { balance: state.balance };
    },
    async updateBalance(_userId: string, delta: number, _type: string, _details: string) {
      state.balanceUpdateCalls++;
      state.totalDeducted += -delta;
      state.balance += delta;
      return state.balance;
    },
    async trainPet(_userId: string, stat: "attack" | "defense" | "speed") {
      await delay(2);
      state.trainCalls++;
      if (!state.pet) return null;
      const gain = 1;
      state.pet[stat] += gain;
      return { stat, gain, newValue: state.pet[stat] };
    },
  };
});

// Import AFTER mocks.
// @ts-expect-error - importing JS module without types
import { executeSocialTool } from "../../ai/socialExecutor.js";

describe("pet_train cooldown atomicity", () => {
  beforeEach(() => {
    state.balance = 1000;
    state.pet = { attack: 5, defense: 5, speed: 5 };
    state.trainCalls = 0;
    state.balanceUpdateCalls = 0;
    state.totalDeducted = 0;
  });

  it("two parallel pet_train calls only charge once (cooldown is atomic)", async () => {
    // Use a unique userId per test run so no carry-over from any other test
    // pollutes the in-memory _cooldowns Map in database.js.
    const userId = `train-race-${Date.now()}-${Math.random()}`;
    const message: any = { author: { id: userId } };

    const [a, b] = await Promise.all([
      executeSocialTool("pet_train", { stat: "attack" }, message),
      executeSocialTool("pet_train", { stat: "attack" }, message),
    ]);

    // Exactly one call should have been blocked by the cooldown.
    const trainedReplies = [a, b].filter((r: string) => r.startsWith("trained")).length;
    const cooldownReplies = [a, b].filter((r: string) => r.includes("cooldown")).length;

    expect(trainedReplies).toBe(1);
    expect(cooldownReplies).toBe(1);
    // Critical: only ONE 100-coin deduction.
    expect(state.balanceUpdateCalls).toBe(1);
    expect(state.totalDeducted).toBe(100);
    // And only ONE pet train write.
    expect(state.trainCalls).toBe(1);
  });
});
