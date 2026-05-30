import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Set Supabase env BEFORE config is imported so the persisted-stat helpers
// (game stats, trivia, prefs) run against our mock client. The in-memory
// session/duel/confession helpers don't touch Supabase at all.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
});

// ─── Backing stores for persisted game/trivia/preference stats ──────────────
type StatRow = {
  user_id: string; game_type: string;
  wins: number; losses: number; current_streak: number; best_streak: number;
  total_wagered: number; total_won: number;
};
type TriviaRow = { user_id: string; correct: number; wrong: number; current_streak: number; best_streak: number };
type PrefRow = { user_id: string; topics?: string[]; sentiment_avg?: number; interaction_style?: string | null; updated_at?: string };

let gameStats: StatRow[] = [];
let trivia: TriviaRow[] = [];
let prefs: PrefRow[] = [];

function statChain() {
  return {
    select(_c = "*") {
      return {
        eq(col1: string, val1: any) {
          return {
            // getGameStats: .eq(user).eq(game_type).single()
            eq(_col2: string, val2: any) {
              return { async single() { const r = gameStats.find(s => s.user_id === val1 && s.game_type === val2); return { data: r ? { ...r } : null, error: null }; } };
            },
          };
        },
      };
    },
    upsert(row: any) {
      const idx = gameStats.findIndex(s => s.user_id === row.user_id && s.game_type === row.game_type);
      if (idx >= 0) gameStats[idx] = { ...gameStats[idx], ...row };
      else gameStats.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function triviaChain() {
  return {
    select(_c = "*") {
      return { eq(_col: string, val: any) { return { async single() { const r = trivia.find(t => t.user_id === val); return { data: r ? { ...r } : null, error: null }; } }; } };
    },
    upsert(row: any) {
      const idx = trivia.findIndex(t => t.user_id === row.user_id);
      if (idx >= 0) trivia[idx] = { ...trivia[idx], ...row };
      else trivia.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function prefChain() {
  return {
    select(_c = "*") {
      return { eq(_col: string, val: any) { return { async single() { const r = prefs.find(p => p.user_id === val); return { data: r ? { ...r } : null, error: null }; } }; } };
    },
    upsert(row: any) {
      const idx = prefs.findIndex(p => p.user_id === row.user_id);
      if (idx >= 0) prefs[idx] = { ...prefs[idx], ...row };
      else prefs.push({ ...row });
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
      if (table === "eris_game_stats") return statChain();
      if (table === "eris_trivia") return triviaChain();
      if (table === "eris_user_preferences") return prefChain();
      return makeNoopChain();
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

let db: any;

beforeEach(async () => {
  gameStats = [];
  trivia = [];
  prefs = [];
  vi.resetModules();
  vi.useRealTimers();
  db = await import("../../database.js");
  await db.initDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("games.js — persisted game stats & streaks", () => {
  it("getGameStats returns zeroed defaults for a new user", async () => {
    const s = await db.getGameStats("u1", "coinflip");
    expect(s).toMatchObject({ wins: 0, losses: 0, current_streak: 0, best_streak: 0, total_wagered: 0, total_won: 0 });
  });

  it("recordGameResult builds a positive streak on consecutive wins and tracks best", async () => {
    await db.recordGameResult("u2", "dice", true, 100, 200);
    await db.recordGameResult("u2", "dice", true, 50, 100);
    const s = await db.getGameStats("u2", "dice");
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(0);
    expect(s.current_streak).toBe(2);
    expect(s.best_streak).toBe(2);
    expect(s.total_wagered).toBe(150);
    expect(s.total_won).toBe(300);
  });

  it("a loss after wins flips the streak to -1 and does not lower best_streak", async () => {
    await db.recordGameResult("u3", "slots", true);
    await db.recordGameResult("u3", "slots", true); // streak 2, best 2
    await db.recordGameResult("u3", "slots", false); // loss → -1
    const s = await db.getGameStats("u3", "slots");
    expect(s.current_streak).toBe(-1);
    expect(s.best_streak).toBe(2);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
  });

  it("consecutive losses deepen a negative streak", async () => {
    await db.recordGameResult("u4", "rps", false);
    await db.recordGameResult("u4", "rps", false);
    const s = await db.getGameStats("u4", "rps");
    expect(s.current_streak).toBe(-2);
    expect(s.best_streak).toBe(0);
  });

  it("a win after a loss streak resets the streak to +1", async () => {
    await db.recordGameResult("u5", "rps", false);
    await db.recordGameResult("u5", "rps", false); // -2
    await db.recordGameResult("u5", "rps", true); // → +1
    const s = await db.getGameStats("u5", "rps");
    expect(s.current_streak).toBe(1);
  });
});

describe("games.js — in-memory active game sessions", () => {
  it("save/get/delete an active game", () => {
    db.saveActiveGame("chan", "u1", "blackjack", { hand: [1, 2] }, 50);
    const g = db.getActiveGame("chan", "u1", "blackjack");
    expect(g).toMatchObject({ stake: 50 });
    expect(g.gameState).toEqual({ hand: [1, 2] });
    db.deleteActiveGame("chan", "u1", "blackjack");
    expect(db.getActiveGame("chan", "u1", "blackjack")).toBeNull();
  });

  it("getActiveGame returns null for an unknown key", () => {
    expect(db.getActiveGame("nope", "nobody", "none")).toBeNull();
  });

  it("auto-expires a session older than 5 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    db.saveActiveGame("c", "u", "g", {}, 10);
    vi.setSystemTime(new Date("2026-01-01T00:05:01Z")); // 5m1s later
    expect(db.getActiveGame("c", "u", "g")).toBeNull();
  });

  it("cleanupExpiredGames returns and removes only stale sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    db.saveActiveGame("c1", "u1", "g1", {}, 5);
    vi.setSystemTime(new Date("2026-01-01T00:04:00Z")); // 4 min later — fresh game added now
    db.saveActiveGame("c2", "u2", "g2", {}, 7);
    // Default maxAge is 180s (3 min). c1 is 4 min old (stale), c2 is brand new.
    const expired = db.cleanupExpiredGames();
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ channelId: "c1", userId: "u1", gameType: "g1", stake: 5 });
    // c2 survives.
    expect(db.getActiveGame("c2", "u2", "g2")).not.toBeNull();
  });
});

describe("games.js — duels", () => {
  it("createDuel registers a pending duel and getPendingDuel returns it", () => {
    expect(db.createDuel("challenger", "target", "chan", 100)).toEqual({ success: true });
    const duel = db.getPendingDuel("chan", "target");
    expect(duel).toMatchObject({ challengerId: "challenger", targetId: "target", stake: 100 });
  });

  it("rejects a second duel for the same target+channel", () => {
    db.createDuel("a", "t", "chan");
    const res = db.createDuel("b", "t", "chan");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already has a pending duel/);
  });

  it("resolveDuel returns the duel and clears it", () => {
    db.createDuel("a", "t2", "chan", 25);
    const resolved = db.resolveDuel("chan", "t2");
    expect(resolved).toMatchObject({ challengerId: "a", stake: 25 });
    expect(db.getPendingDuel("chan", "t2")).toBeNull();
  });

  it("cleanupExpiredDuels removes stale pending duels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    db.createDuel("a", "t3", "chan");
    vi.setSystemTime(new Date("2026-02-01T00:05:01Z")); // past 300s default
    db.cleanupExpiredDuels();
    expect(db.getPendingDuel("chan", "t3")).toBeNull();
  });
});

describe("games.js — confessions", () => {
  it("saveConfession queues a confession and getUnpostedConfessions drains it", async () => {
    expect(await db.saveConfession("u", "g", "c", "a secret")).toBe(true);
    const drained = db.getUnpostedConfessions();
    expect(drained).toHaveLength(1);
    expect(drained[0].text).toBe("a secret");
    // Drain empties the queue.
    expect(db.getUnpostedConfessions()).toHaveLength(0);
  });

  it("rejects empty or over-length confessions", async () => {
    expect(await db.saveConfession("u", "g", "c", "")).toBe(false);
    expect(await db.saveConfession("u", "g", "c", "x".repeat(2001))).toBe(false);
    expect(db.getUnpostedConfessions()).toHaveLength(0);
  });

  it("getConfessionNumber increments monotonically", () => {
    const a = db.getConfessionNumber();
    const b = db.getConfessionNumber();
    expect(b).toBe(a + 1);
  });
});

describe("games.js — trivia stats", () => {
  it("getTriviaStats returns defaults for a new user", async () => {
    expect(await db.getTriviaStats("nu")).toMatchObject({ correct: 0, wrong: 0, current_streak: 0, best_streak: 0 });
  });

  it("correct answers grow the streak; a wrong answer resets it to 0", async () => {
    await db.recordTriviaResult("tu", true);
    await db.recordTriviaResult("tu", true); // streak 2
    let s = await db.getTriviaStats("tu");
    expect(s.correct).toBe(2);
    expect(s.current_streak).toBe(2);
    expect(s.best_streak).toBe(2);
    await db.recordTriviaResult("tu", false); // reset streak, +1 wrong, best stays
    s = await db.getTriviaStats("tu");
    expect(s.wrong).toBe(1);
    expect(s.current_streak).toBe(0);
    expect(s.best_streak).toBe(2);
  });
});

describe("games.js — user preferences", () => {
  it("getUserPreferences returns defaults then reflects an upsert", async () => {
    expect(await db.getUserPreferences("pu")).toMatchObject({ topics: [], sentiment_avg: 0, interaction_style: null });
    await db.updateUserPreferences("pu", { sentiment_avg: 0.5, interaction_style: "playful" });
    const p = await db.getUserPreferences("pu");
    expect(p.sentiment_avg).toBe(0.5);
    expect(p.interaction_style).toBe("playful");
  });
});
