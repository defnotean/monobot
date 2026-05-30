// Memory-maintenance tests — prune-by-age, dedupe-on-insert, recall-bump,
// type-exemption, and the runMemoryMaintenance scheduler entry point.
//
// These tests build a chainable fake of the supabase client just deep enough
// for the semantic.js call sites (storeEpisode + pruneMemories). The wider
// tests/mocks/supabase.ts is too rigid for the new delete()/eq()/lt()/eq()
// chain and the update()/eq() chain, so we use a focused fake per test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Fake Supabase ─────────────────────────────────────────────────────────
// Each call resets to a fresh in-memory store. Returns a chainable query
// builder that records intent and resolves with .then-able results, matching
// the surface that semantic.js relies on.

type Row = {
  id?: string;
  bot_id?: string;
  user_id?: string;
  channel_id?: string | null;
  guild_id?: string | null;
  type?: string;
  content?: string;
  keywords?: string[];
  embedding?: string;
  created_at?: string;
};

function makeFakeSupabase() {
  const tables: Record<string, Row[]> = { eris_episodic_memories: [] };
  let _autoId = 1;

  function from(tableName: string) {
    if (!tables[tableName]) tables[tableName] = [];
    return {
      select(_cols: string) {
        const filters: Array<(r: Row) => boolean> = [];
        let order: { col: keyof Row; descending: boolean } | null = null;
        let limit = Infinity;
        const builder = {
          eq(col: keyof Row, val: unknown) {
            filters.push(r => r[col] === val);
            return builder;
          },
          order(col: keyof Row, opts?: { ascending?: boolean }) {
            order = { col, descending: opts?.ascending === false };
            return builder;
          },
          limit(n: number) {
            limit = n;
            return builder;
          },
          then(resolve: (val: { data: Row[] | null; error: null }) => unknown) {
            let rows = tables[tableName].filter(r => filters.every(f => f(r)));
            if (order) {
              const { col, descending } = order;
              rows = [...rows].sort((a, b) => {
                const av = String(a[col] ?? "");
                const bv = String(b[col] ?? "");
                return descending ? bv.localeCompare(av) : av.localeCompare(bv);
              });
            }
            if (Number.isFinite(limit)) rows = rows.slice(0, limit);
            return resolve({ data: rows, error: null });
          },
        };
        return builder;
      },
      insert(row: Row) {
        const created = { id: String(_autoId++), created_at: new Date().toISOString(), ...row };
        tables[tableName].push(created);
        return Promise.resolve({ data: created, error: null });
      },
      update(updates: Partial<Row>) {
        const filters: Array<(r: Row) => boolean> = [];
        const builder = {
          eq(col: keyof Row, val: unknown) {
            filters.push(r => r[col] === val);
            return builder;
          },
          then(resolve: (val: { data: null; error: null }) => unknown) {
            for (const r of tables[tableName]) {
              if (filters.every(f => f(r))) Object.assign(r, updates);
            }
            return resolve({ data: null, error: null });
          },
        };
        return builder;
      },
      delete() {
        const filters: Array<(r: Row) => boolean> = [];
        const builder = {
          eq(col: keyof Row, val: unknown) {
            filters.push(r => r[col] === val);
            return builder;
          },
          lt(col: keyof Row, val: unknown) {
            filters.push(r => String(r[col] ?? "") < String(val));
            return builder;
          },
          then(resolve: (val: { count: number; error: null }) => unknown) {
            const before = tables[tableName].length;
            tables[tableName] = tables[tableName].filter(r => !filters.every(f => f(r)));
            return resolve({ count: before - tables[tableName].length, error: null });
          },
        };
        return builder;
      },
    };
  }

  return { from, _tables: tables };
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>;

vi.mock("../../database.js", () => ({
  getSupabase: () => fakeSupabase,
}));

// Disable Voyage so storeEpisode skips the network round-trip and the dedupe
// path falls back to exact-content matching.
vi.mock("../../config.js", () => ({
  default: { voyageApiKey: null },
}));

// @ts-expect-error - importing JS module without types
import * as semantic from "../../ai/semantic.js";

beforeEach(() => {
  fakeSupabase = makeFakeSupabase();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const NOW = () => new Date().toISOString();
const DAYS_AGO = (n: number) => new Date(Date.now() - n * 24 * 3600_000).toISOString();

// ─── pruneMemories ─────────────────────────────────────────────────────────

describe("pruneMemories", () => {
  it("removes exchange-type memories older than retention window (default 30d)", async () => {
    fakeSupabase._tables.eris_episodic_memories.push(
      { id: "old", bot_id: "b1", user_id: "u1", type: "exchange", content: "stale", created_at: DAYS_AGO(45) },
      { id: "fresh", bot_id: "b1", user_id: "u1", type: "exchange", content: "fresh", created_at: DAYS_AGO(5) },
    );
    const result = await semantic.pruneMemories({ botId: "b1" });
    expect(result.deleted).toBe(1);
    const ids = fakeSupabase._tables.eris_episodic_memories.map(r => r.id);
    expect(ids).toEqual(["fresh"]);
  });

  it("keeps emotionally significant types even when old", async () => {
    fakeSupabase._tables.eris_episodic_memories.push(
      { id: "bond", bot_id: "b1", user_id: "u1", type: "bond", content: "important", created_at: DAYS_AGO(120) },
      { id: "tension", bot_id: "b1", user_id: "u1", type: "tension", content: "fight", created_at: DAYS_AGO(120) },
      { id: "ex-old", bot_id: "b1", user_id: "u1", type: "exchange", content: "chatter", created_at: DAYS_AGO(120) },
    );
    await semantic.pruneMemories({ botId: "b1" });
    const ids = fakeSupabase._tables.eris_episodic_memories.map(r => r.id).sort();
    expect(ids).toEqual(["bond", "tension"]);
  });

  it("honors maxAgeDays override", async () => {
    fakeSupabase._tables.eris_episodic_memories.push(
      { id: "a", bot_id: "b1", user_id: "u1", type: "exchange", content: "x", created_at: DAYS_AGO(10) },
      { id: "b", bot_id: "b1", user_id: "u1", type: "exchange", content: "y", created_at: DAYS_AGO(3) },
    );
    await semantic.pruneMemories({ botId: "b1", maxAgeDays: 7 });
    const ids = fakeSupabase._tables.eris_episodic_memories.map(r => r.id);
    expect(ids).toEqual(["b"]);
  });

  it("scopes deletion to a single user when userId provided", async () => {
    fakeSupabase._tables.eris_episodic_memories.push(
      { id: "u1-old", bot_id: "b1", user_id: "u1", type: "exchange", content: "x", created_at: DAYS_AGO(60) },
      { id: "u2-old", bot_id: "b1", user_id: "u2", type: "exchange", content: "y", created_at: DAYS_AGO(60) },
    );
    await semantic.pruneMemories({ botId: "b1", userId: "u1" });
    const ids = fakeSupabase._tables.eris_episodic_memories.map(r => r.id).sort();
    expect(ids).toEqual(["u2-old"]);
  });

  it("no-ops cleanly when supabase is unavailable", async () => {
    fakeSupabase = { from: () => { throw new Error("nope"); }, _tables: { eris_episodic_memories: [] } } as any;
    // Override the mock to return null this one time.
    const db = await import("../../database.js");
    const spy = vi.spyOn(db, "getSupabase").mockReturnValue(null as any);
    const result = await semantic.pruneMemories({ botId: "b1" });
    expect(result.deleted).toBe(0);
    spy.mockRestore();
  });
});

// ─── Dedupe on insert ──────────────────────────────────────────────────────

describe("storeEpisode dedupe", () => {
  it("bumps existing memory when content is exact-match (no embedding path)", async () => {
    const earlier = "2026-05-10T00:00:00.000Z";
    fakeSupabase._tables.eris_episodic_memories.push({
      id: "existing",
      bot_id: "b1",
      user_id: "u1",
      type: "exchange",
      content: "boss likes pineapple pizza",
      created_at: earlier,
    });
    const result = await semantic.storeEpisode("b1", "u1", "c1", "g1", "exchange", "boss likes pineapple pizza");
    expect(result?.deduped).toBe(true);
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(1);
    const row = fakeSupabase._tables.eris_episodic_memories[0];
    // created_at should be bumped to "now" (later than earlier)
    expect(row.created_at).not.toBe(earlier);
    expect(new Date(row.created_at!).getTime()).toBeGreaterThan(new Date(earlier).getTime());
  });

  it("inserts a new row when no near-duplicate exists", async () => {
    const result = await semantic.storeEpisode("b1", "u1", "c1", "g1", "exchange", "totally novel observation");
    expect(result?.deduped).toBe(false);
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(1);
    expect(fakeSupabase._tables.eris_episodic_memories[0].content).toBe("totally novel observation");
  });

  it("does not dedupe across different users", async () => {
    fakeSupabase._tables.eris_episodic_memories.push({
      id: "u1-row",
      bot_id: "b1",
      user_id: "u1",
      type: "exchange",
      content: "we played tic-tac-toe",
      created_at: NOW(),
    });
    await semantic.storeEpisode("b1", "u2", "c1", "g1", "exchange", "we played tic-tac-toe");
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(2);
  });
});

// ─── findDuplicateMemory — embedding path ──────────────────────────────────

describe("findDuplicateMemory embedding similarity", () => {
  it("matches when cosine >= 0.95", async () => {
    // Two near-identical vectors (third dim slightly different) → cosine very close to 1.
    const a = [1.0, 0.0, 0.0];
    const b = [0.999, 0.0447, 0.0]; // ||b|| ≈ 1, dot ≈ 0.999 → cosine ≈ 0.999
    fakeSupabase._tables.eris_episodic_memories.push({
      id: "near",
      bot_id: "b1",
      user_id: "u1",
      type: "exchange",
      content: "stored",
      embedding: JSON.stringify(b),
      created_at: NOW(),
    });
    const dup = await semantic.findDuplicateMemory(fakeSupabase, "b1", "u1", "new content", a);
    expect(dup?.row?.id).toBe("near");
    expect(dup?.similarity).toBeGreaterThan(semantic.DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("does not match when cosine is well below threshold", async () => {
    const a = [1.0, 0.0, 0.0];
    const b = [0.0, 1.0, 0.0]; // orthogonal — cosine 0
    fakeSupabase._tables.eris_episodic_memories.push({
      id: "far",
      bot_id: "b1",
      user_id: "u1",
      type: "exchange",
      content: "stored",
      embedding: JSON.stringify(b),
      created_at: NOW(),
    });
    const dup = await semantic.findDuplicateMemory(fakeSupabase, "b1", "u1", "new content", a);
    expect(dup).toBeNull();
  });
});

// ─── Scheduler entry point ─────────────────────────────────────────────────

describe("runMemoryMaintenance", () => {
  it("returns the prune count and is callable without options", async () => {
    fakeSupabase._tables.eris_episodic_memories.push(
      { id: "old", bot_id: "b1", user_id: "u1", type: "exchange", content: "x", created_at: DAYS_AGO(40) },
      { id: "keep", bot_id: "b1", user_id: "u1", type: "exchange", content: "y", created_at: DAYS_AGO(5) },
    );
    const result = await semantic.runMemoryMaintenance({ botId: "b1" });
    expect(result.pruned).toBe(1);
  });
});
