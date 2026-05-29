// Consolidation-recall regression — the consolidated summary row must stay
// retrievable after the 100 originals are deleted. Previously consolidateMemories
// wrote the summary with keywords:[] and NO embedding, so BOTH retrieval paths
// (vector RPC on embedding, keyword .overlaps) excluded it forever. This suite
// asserts the consolidated row is written with a non-empty keyword list + an
// embedding, and that searchRelevantMemories surfaces it via both paths.
//
// Reuses the chainable-fake-supabase pattern from memoryConsolidation.test.ts,
// extended with .in() (delete-by-ids), .overlaps() (keyword fallback) and rpc()
// (vector search) so the consolidated row can actually be looked up.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
          overlaps(col: keyof Row, vals: unknown[]) {
            filters.push(r => {
              const arr = (r[col] as unknown[]) || [];
              return Array.isArray(arr) && arr.some(v => vals.includes(v));
            });
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
      delete() {
        const filters: Array<(r: Row) => boolean> = [];
        const builder = {
          eq(col: keyof Row, val: unknown) {
            filters.push(r => r[col] === val);
            return builder;
          },
          in(col: keyof Row, vals: unknown[]) {
            filters.push(r => vals.includes(r[col]));
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

  // Vector-search RPC stub: only return rows that actually carry an embedding,
  // mirroring the real pgvector function (rows with NULL embedding are invisible
  // to the similarity query). This is the crux of the regression: a consolidated
  // row without an embedding would never come back here.
  async function rpc(_name: string, params: Record<string, unknown>) {
    const data = tables.eris_episodic_memories
      .filter(r => r.bot_id === params.match_bot && r.user_id === params.match_user)
      .filter(r => typeof r.embedding === "string" && r.embedding.length > 0)
      .slice(0, (params.match_count as number) ?? 3)
      .map(r => ({ type: r.type, content: r.content, similarity: 0.9 }));
    return { data, error: null };
  }

  return { from, rpc, _tables: tables };
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>;

vi.mock("../../database.js", () => ({
  getSupabase: () => fakeSupabase,
}));

// Voyage key present so the embedding + vector-search paths are exercised.
vi.mock("../../config.js", () => ({
  default: { voyageApiKey: "test-voyage-key", botName: "test-eris" },
}));

// @ts-expect-error - importing JS module without types
import * as semantic from "../../ai/semantic.js";

const ISO_AT = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

function seedExchanges(count: number, userId = "u1") {
  for (let i = 0; i < count; i++) {
    fakeSupabase._tables.eris_episodic_memories.push({
      id: `exchange-${userId}-${i}`,
      bot_id: "test-eris",
      user_id: userId,
      type: "exchange",
      content: `fragment ${i}: something happened`,
      created_at: ISO_AT(i - count),
    });
  }
}

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

// The Voyage rate-limiter trackers are module-level state with no reset hook, so
// each test must advance the clock past the 2s gap of the previous test's last
// embedding call — otherwise the store tracker stays "fresh" at a fixed system
// time and generateEmbedding(summary) gets rate-limited to null. Bump the clock
// forward per test off a fixed base.
const _CLOCK_BASE = new Date("2026-05-28T12:00:00Z").getTime();
let _clockMin = 0;

beforeEach(() => {
  fakeSupabase = makeFakeSupabase();
  vi.useFakeTimers();
  _clockMin += 1;
  vi.setSystemTime(new Date(_CLOCK_BASE + _clockMin * 60_000));
  semantic.__setConsolidationBudget(0, Date.now());

  // Stub Voyage so generateEmbedding / generateQueryEmbedding return a vector
  // without a network call. Tests must not curl real APIs.
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

describe("consolidateMemories writes a retrievable summary row", () => {
  it("populates non-empty keywords from the summary (keyword fallback can find it)", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue(
      "Valerie kept joking about being banned for cheating in ranked matches",
    );

    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(true);

    const consolidated = fakeSupabase._tables.eris_episodic_memories.filter(
      r => r.type === semantic.CONSOLIDATED_TYPE,
    );
    expect(consolidated).toHaveLength(1);
    // Keywords derived from the summary, same shape as storeEpisode: lowercased,
    // word length > 3, capped at 10.
    expect(consolidated[0].keywords).toBeTruthy();
    expect(consolidated[0].keywords!.length).toBeGreaterThan(0);
    expect(consolidated[0].keywords).toContain("valerie");
    expect(consolidated[0].keywords).toContain("banned");
    expect(consolidated[0].keywords!.length).toBeLessThanOrEqual(10);
  });

  it("attaches an embedding so the vector-search RPC surfaces it", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("a through-line about gaming drama");

    await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });

    const consolidated = fakeSupabase._tables.eris_episodic_memories.find(
      r => r.type === semantic.CONSOLIDATED_TYPE,
    );
    expect(consolidated).toBeTruthy();
    expect(typeof consolidated!.embedding).toBe("string");
    // It's the JSON-serialized vector returned by the stubbed Voyage call.
    expect(JSON.parse(consolidated!.embedding!)).toEqual([0.1, 0.2, 0.3]);
  });

  it("searchRelevantMemories returns the consolidated row via vector search", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("a through-line about gaming drama");

    await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });

    // The 100 originals are gone; only the consolidated row carries an embedding.
    const hits = await semantic.searchRelevantMemories("test-eris", "u1", "tell me about the gaming drama");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.type === semantic.CONSOLIDATED_TYPE)).toBe(true);
  });

  it("searchRelevantMemories finds the consolidated row via keyword fallback when vector search is empty", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue(
      "Valerie kept joking about being banned for cheating in ranked matches",
    );

    await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });

    // Force the vector path to come back empty so the keyword .overlaps()
    // fallback is exercised; it must still find the consolidated row.
    const rpcSpy = vi.spyOn(fakeSupabase, "rpc").mockResolvedValue({ data: [], error: null });
    // Use a stale-cache-free key by querying with the keyword the summary
    // produced — "banned" overlaps the consolidated row's keywords.
    const hits = await semantic.searchRelevantMemories("test-eris", "u1", "was anyone banned recently");
    expect(hits.some(h => h.type === semantic.CONSOLIDATED_TYPE)).toBe(true);
    rpcSpy.mockRestore();
  });
});
