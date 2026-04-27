import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported. vi.hoisted() runs before any
// import statement, so config.supabaseEnabled sees these on first read.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

type ChallengeRow = {
  id: string;
  completed_by: string[];
};
const challenges: Map<string, ChallengeRow> = new Map();
let yieldDelayMs = 1;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table !== "eris_daily_challenges") return makeNoopChain();
      return {
        select(_cols: string = "*") {
          return {
            eq(col: string, val: any) {
              return {
                async single() {
                  await delay(yieldDelayMs);
                  if (col !== "id") return { data: null, error: null };
                  const row = challenges.get(val);
                  // Return a copy of completed_by so the caller can't mutate
                  // our store directly (mirrors PostgREST returning JSON).
                  return {
                    data: row ? { ...row, completed_by: [...row.completed_by] } : null,
                    error: null,
                  };
                },
              };
            },
          };
        },
        update(updates: Partial<ChallengeRow>) {
          return {
            eq(col: string, val: any) {
              // Return a thenable so `await supabase...update().eq(...)` works.
              return {
                then(onFulfilled: any) {
                  return delay(yieldDelayMs).then(() => {
                    const row = challenges.get(val);
                    if (row) {
                      // Apply the update — this is a destructive write
                      // (overwrites completed_by with the caller's array).
                      Object.assign(row, updates);
                      if (updates.completed_by) row.completed_by = [...updates.completed_by];
                    }
                    return onFulfilled({ error: null });
                  });
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
  const chain: any = {};
  const methods = ["select", "eq", "neq", "gt", "lt", "gte", "lte", "in", "or",
    "order", "limit", "insert", "upsert", "update", "delete", "from"];
  for (const m of methods) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.then = (resolve: any) => resolve({ data: null, error: null });
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeMockSupabase(),
}));

// Import AFTER mocks are set up.
// @ts-expect-error - importing JS module without types
import { initDatabase, completeDailyChallenge } from "../../database.js";

describe("completeDailyChallenge concurrency", () => {
  beforeEach(async () => {
    challenges.clear();
    await initDatabase();
  });

  it("preserves both ids when two users complete the same challenge concurrently", async () => {
    const challengeId = "challenge-1";
    challenges.set(challengeId, { id: challengeId, completed_by: [] });

    await Promise.all([
      completeDailyChallenge(challengeId, "userA"),
      completeDailyChallenge(challengeId, "userB"),
    ]);

    const final = challenges.get(challengeId)!;
    expect(final.completed_by).toContain("userA");
    expect(final.completed_by).toContain("userB");
    expect(final.completed_by).toHaveLength(2);
  });

  it("preserves all ids when many users complete the same challenge in parallel", async () => {
    const challengeId = "challenge-many";
    challenges.set(challengeId, { id: challengeId, completed_by: [] });

    const userIds = Array.from({ length: 10 }, (_, i) => `user${i}`);
    await Promise.all(userIds.map((uid) => completeDailyChallenge(challengeId, uid)));

    const final = challenges.get(challengeId)!;
    for (const uid of userIds) {
      expect(final.completed_by).toContain(uid);
    }
    expect(final.completed_by).toHaveLength(10);
  });

  it("is idempotent — calling completeDailyChallenge twice for the same user does not duplicate", async () => {
    const challengeId = "challenge-idempotent";
    challenges.set(challengeId, { id: challengeId, completed_by: [] });

    await completeDailyChallenge(challengeId, "userA");
    await completeDailyChallenge(challengeId, "userA");

    const final = challenges.get(challengeId)!;
    expect(final.completed_by.filter((u) => u === "userA")).toHaveLength(1);
  });

  it("preserves existing completions when a new user completes", async () => {
    const challengeId = "challenge-additive";
    challenges.set(challengeId, { id: challengeId, completed_by: ["preExisting"] });

    await completeDailyChallenge(challengeId, "newUser");

    const final = challenges.get(challengeId)!;
    expect(final.completed_by).toContain("preExisting");
    expect(final.completed_by).toContain("newUser");
    expect(final.completed_by).toHaveLength(2);
  });
});
