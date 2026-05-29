// Memory-privacy regression — companion-bot privacy gaps:
//   1) secret-tier content must NOT be embedded / written to the searchable
//      episodic store (storeEpisode skips it entirely)
//   2) deleteEpisodicMemoriesForUser wipes ALL episodic rows for (botId, userId)
//      regardless of type/age — the destructive companion to clearAllFacts
//   3) the delete reports partial failure (ok:false) so the caller never
//      claims a clean wipe it didn't perform
//
// Reuses the chainable-fake-supabase shape from memoryConsolidation.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Row = {
  id?: string;
  bot_id?: string;
  user_id?: string;
  type?: string;
  content?: string;
  keywords?: string[];
  embedding?: string;
  created_at?: string;
};

function makeFakeSupabase(opts: { deleteError?: string } = {}) {
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
          order(col: keyof Row, o?: { ascending?: boolean }) {
            order = { col, descending: o?.ascending === false };
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
      delete() {
        const filters: Array<(r: Row) => boolean> = [];
        const builder = {
          eq(col: keyof Row, val: unknown) {
            filters.push(r => r[col] === val);
            return builder;
          },
          then(resolve: (val: { count: number; error: { message: string } | null }) => unknown) {
            if (opts.deleteError) {
              return resolve({ count: 0, error: { message: opts.deleteError } });
            }
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

// voyageApiKey set so storeEpisode WOULD attempt to embed — the secret guard
// has to short-circuit BEFORE that, which we prove by asserting fetch is never
// called and no row lands in the table.
vi.mock("../../config.js", () => ({
  default: { voyageApiKey: "test-voyage-key", botName: "test-eris" },
}));

// @ts-expect-error - importing JS module without types
import * as semantic from "../../ai/semantic.js";

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fakeSupabase = makeFakeSupabase();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-28T12:00:00Z"));
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  }));
  globalThis.fetch = fetchSpy as never;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ─── Secret-tier content is never embedded / stored ─────────────────────────

describe("storeEpisode secret-tier privacy", () => {
  it("does NOT embed or store content flagged secret", async () => {
    const res = await semantic.storeEpisode(
      "test-eris", "u1", "c1", "g1", "venting",
      "i'm secretly in love with my best friend",
      { sensitivity: "secret" },
    );

    expect(res).toEqual({ skipped: true, reason: "secret-tier-not-embedded" });
    // No embedding call was made — the secret never reached Voyage.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing landed in the searchable store.
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(0);
  });

  it("still stores normal-tier content (no regression to the default path)", async () => {
    await semantic.storeEpisode(
      "test-eris", "u1", "c1", "g1", "exchange",
      "we talked about pizza toppings",
    );
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(1);

    // And an explicit non-secret sensitivity is also stored.
    await semantic.storeEpisode(
      "test-eris", "u1", "c1", "g1", "exchange",
      "another casual exchange about movies",
      { sensitivity: "normal" },
    );
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(2);
  });
});

// ─── Right to be forgotten: episodic delete-by-user ─────────────────────────

function seed(rows: Array<Partial<Row>>) {
  for (const r of rows) {
    fakeSupabase._tables.eris_episodic_memories.push({
      id: r.id ?? String(Math.random()),
      bot_id: r.bot_id ?? "test-eris",
      user_id: r.user_id ?? "u1",
      type: r.type ?? "exchange",
      content: r.content ?? "x",
      created_at: r.created_at ?? new Date().toISOString(),
    });
  }
}

describe("deleteEpisodicMemoriesForUser", () => {
  it("deletes ALL episodic rows for (botId, userId) regardless of type/age", async () => {
    seed([
      { id: "a", type: "exchange" },
      { id: "b", type: "bond" },        // emotionally-significant — prune exempts it, forget must NOT
      { id: "c", type: "tension" },
      { id: "d", type: "venting", created_at: new Date(Date.now() - 365 * 86400000).toISOString() },
    ]);
    // Another user's rows + another bot's rows must survive.
    seed([{ id: "other-user", user_id: "u2" }]);
    seed([{ id: "other-bot", bot_id: "other-eris" }]);

    const res = await semantic.deleteEpisodicMemoriesForUser("test-eris", "u1");
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(4);

    const remaining = fakeSupabase._tables.eris_episodic_memories;
    // Only the other-user and other-bot rows are left.
    expect(remaining.map(r => r.id).sort()).toEqual(["other-bot", "other-user"]);
  });

  it("reports ok:false with the error when the delete fails (no false clean-wipe)", async () => {
    fakeSupabase = makeFakeSupabase({ deleteError: "permission denied" });
    seed([{ id: "a" }]);

    const res = await semantic.deleteEpisodicMemoriesForUser("test-eris", "u1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission denied/);
  });

  it("treats a missing userId as a failure", async () => {
    const res = await semantic.deleteEpisodicMemoriesForUser("test-eris", "");
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
  });

  it("no-ops cleanly (ok:true) when supabase is unavailable", async () => {
    const db = await import("../../database.js");
    const spy = vi.spyOn(db, "getSupabase").mockReturnValue(null as never);
    const res = await semantic.deleteEpisodicMemoriesForUser("test-eris", "u1");
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(0);
    spy.mockRestore();
  });
});
