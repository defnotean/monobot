// Memory-consolidation tests — LLM-driven folding of generic "exchange"
// memories into a single "consolidated" row when a user crosses the
// MEMORY_CONSOLIDATION_THRESHOLD. Covers:
//   - trigger threshold (over vs under)
//   - LLM success → originals deleted, summary inserted
//   - LLM failure → originals preserved, no insert
//   - per-process daily cost cap honored
//   - emotional-type exemption (bond/tension/venting/opinion untouched)
//   - graceful no-op when no LLM provider is available
//
// We reuse the same chainable-fake-supabase pattern as memoryMaintenance.test.ts
// — the production code uses select().eq().eq().eq().order().limit() and the
// real shape of a delete-by-id-chain, so the fake mirrors that surface.

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

vi.mock("../../config.js", () => ({
  default: { voyageApiKey: null, botName: "test-eris" },
}));

// @ts-expect-error - importing JS module without types
import * as semantic from "../../ai/semantic.js";

const ISO_AT = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

function seedExchanges(count: number, opts: { botId?: string; userId?: string; type?: string } = {}) {
  const botId = opts.botId ?? "test-eris";
  const userId = opts.userId ?? "u1";
  const type = opts.type ?? "exchange";
  for (let i = 0; i < count; i++) {
    fakeSupabase._tables.eris_episodic_memories.push({
      id: `${type}-${userId}-${i}`,
      bot_id: botId,
      user_id: userId,
      type,
      content: `fragment ${i}: something happened`,
      // Older rows first so the "ascending order" select returns them as the
      // oldest. Each is 1 minute apart so deterministic ordering is preserved.
      created_at: ISO_AT(i - count),
    });
  }
}

beforeEach(() => {
  fakeSupabase = makeFakeSupabase();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
  // Reset the per-process budget counter before each test so state from a
  // previous test doesn't bleed in.
  semantic.__setConsolidationBudget(0, Date.now());
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Threshold trigger ─────────────────────────────────────────────────────

describe("consolidateMemories threshold", () => {
  it("no-ops when user is under the threshold", async () => {
    seedExchanges(50); // way under default 300
    const summarize = vi.fn().mockResolvedValue("summary");
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 300,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(result.reason).toBe("under-threshold");
    // LLM was never called — nothing to summarize
    expect(summarize).not.toHaveBeenCalled();
    // All originals preserved
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(50);
  });

  it("no-ops at exactly the threshold (boundary — strictly greater required)", async () => {
    seedExchanges(300);
    const summarize = vi.fn().mockResolvedValue("summary");
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 300,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(300);
  });

  it("triggers consolidation when user is over the threshold", async () => {
    // Use a small threshold so we don't have to seed 300 rows.
    seedExchanges(110); // > threshold of 10
    const summarize = vi.fn().mockResolvedValue("a paragraph capturing the through-line");
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    // Summarizer received exactly 100 fragments
    const fragments = summarize.mock.calls[0][0] as string[];
    expect(fragments).toHaveLength(100);
  });
});

// ─── LLM success → 100 deleted, 1 inserted ────────────────────────────────

describe("consolidateMemories on LLM success", () => {
  it("deletes the oldest 100 originals and inserts a single consolidated row", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("a paragraph capturing the through-line");
    const before = fakeSupabase._tables.eris_episodic_memories.length;
    expect(before).toBe(110);

    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(true);

    // 110 originals - 100 deleted + 1 consolidated = 11 rows
    const remaining = fakeSupabase._tables.eris_episodic_memories;
    expect(remaining).toHaveLength(11);

    // Exactly one consolidated row exists
    const consolidated = remaining.filter(r => r.type === semantic.CONSOLIDATED_TYPE);
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].bot_id).toBe("test-eris");
    expect(consolidated[0].user_id).toBe("u1");
    expect(consolidated[0].content).toContain("a paragraph capturing the through-line");

    // The 10 newest exchange rows are preserved
    const remainingExchanges = remaining.filter(r => r.type === "exchange");
    expect(remainingExchanges).toHaveLength(10);
    // Indices 100..109 are the newest 10 — they should be the ones kept
    const keptIds = remainingExchanges.map(r => r.id).sort();
    expect(keptIds).toContain("exchange-u1-100");
    expect(keptIds).toContain("exchange-u1-109");
  });
});

// ─── LLM failure → no deletion ─────────────────────────────────────────────

describe("consolidateMemories on LLM failure", () => {
  it("preserves all originals when the summarizer returns null", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue(null);

    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(result.reason).toBe("llm-empty");

    // Nothing deleted, nothing inserted
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(110);
    expect(
      fakeSupabase._tables.eris_episodic_memories.filter(r => r.type === semantic.CONSOLIDATED_TYPE),
    ).toHaveLength(0);
  });

  it("preserves all originals when the summarizer throws", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockRejectedValue(new Error("provider down"));

    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(result.reason).toBe("llm-error");
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(110);
  });

  it("preserves originals when summarizer returns whitespace-only", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("   ");
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(110);
  });
});

// ─── Cost cap ──────────────────────────────────────────────────────────────

describe("consolidateMemories budget cap", () => {
  it("skips with budget-exhausted reason when daily counter is at the cap", async () => {
    seedExchanges(110);
    // Manually exhaust the budget (default cap is 50/day)
    semantic.__setConsolidationBudget(50, Date.now());
    const summarize = vi.fn().mockResolvedValue("ok");

    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(result.reason).toBe("budget-exhausted");
    expect(summarize).not.toHaveBeenCalled();
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(110);
  });

  it("increments the budget counter on each LLM call attempt (success or fail)", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("ok");

    expect(semantic.__getConsolidationBudget().used).toBe(0);
    await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(semantic.__getConsolidationBudget().used).toBe(1);
  });

  it("resets the budget after the 24h window elapses", async () => {
    // Place the window start 25h in the past — it should auto-reset.
    semantic.__setConsolidationBudget(50, Date.now() - 25 * 3600_000);
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("ok");

    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    // Window resets internally → not budget-exhausted
    expect(result.consolidated).toBe(true);
    // Budget counter was reset to 0 then incremented to 1
    expect(semantic.__getConsolidationBudget().used).toBe(1);
  });
});

// ─── Emotional-type exemption ──────────────────────────────────────────────

describe("consolidateMemories emotional exemption", () => {
  it("never touches bond/tension/venting/opinion memories", async () => {
    // Seed a mix: 50 emotional (which should be ignored entirely) and 110
    // exchange (which should trigger consolidation).
    for (const type of ["bond", "tension", "venting", "opinion"]) {
      for (let i = 0; i < 50; i++) {
        fakeSupabase._tables.eris_episodic_memories.push({
          id: `${type}-${i}`,
          bot_id: "test-eris",
          user_id: "u1",
          type,
          content: `${type} memory ${i}`,
          created_at: ISO_AT(-1000 + i),
        });
      }
    }
    seedExchanges(110);

    const summarize = vi.fn().mockResolvedValue("through-line summary");
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize,
    });
    expect(result.consolidated).toBe(true);

    // Emotional memories — all 200 still present (50 × 4 types)
    const emotional = fakeSupabase._tables.eris_episodic_memories.filter(r =>
      ["bond", "tension", "venting", "opinion"].includes(r.type ?? ""),
    );
    expect(emotional).toHaveLength(200);

    // Summarizer was called with exchange fragments ONLY — none of them should
    // contain the strings "bond memory" / "tension memory" / etc.
    const fragments = summarize.mock.calls[0][0] as string[];
    for (const f of fragments) {
      expect(f).not.toMatch(/bond memory|tension memory|venting memory|opinion memory/);
    }
  });
});

// ─── Missing LLM provider ──────────────────────────────────────────────────

describe("consolidateMemories without an LLM provider", () => {
  it("handles a summarizer that returns null gracefully (no crash, no deletion)", async () => {
    seedExchanges(110);
    // Simulate "provider unavailable" — summarizer just returns null
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      summarize: async () => null,
    });
    expect(result.consolidated).toBe(false);
    expect(result.reason).toBe("llm-empty");
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(110);
  });

  it("dry-run mode reports what WOULD happen without writing or deleting", async () => {
    seedExchanges(110);
    const summarize = vi.fn().mockResolvedValue("never called");
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      batchSize: 100,
      dryRun: true,
      summarize,
    });
    expect(result.consolidated).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.count).toBe(100);
    // LLM should NOT be called in dry-run
    expect(summarize).not.toHaveBeenCalled();
    // Nothing written
    expect(fakeSupabase._tables.eris_episodic_memories).toHaveLength(110);
  });

  it("no-ops cleanly when supabase is unavailable", async () => {
    const db = await import("../../database.js");
    const spy = vi.spyOn(db, "getSupabase").mockReturnValue(null as never);
    const result = await semantic.consolidateMemories("test-eris", "u1", {
      threshold: 10,
      summarize: async () => "ok",
    });
    expect(result.consolidated).toBe(false);
    expect(result.reason).toBe("no-supabase");
    spy.mockRestore();
  });

  it("rejects calls missing botId or userId", async () => {
    const r1 = await semantic.consolidateMemories("", "u1", { summarize: async () => "ok" });
    const r2 = await semantic.consolidateMemories("b1", "", { summarize: async () => "ok" });
    expect(r1.consolidated).toBe(false);
    expect(r1.reason).toBe("missing-identifiers");
    expect(r2.consolidated).toBe(false);
    expect(r2.reason).toBe("missing-identifiers");
  });
});

// ─── Scheduler integration ─────────────────────────────────────────────────

describe("runMemoryMaintenance wires prune + consolidate", () => {
  it("reports both prune count and consolidated-user count", async () => {
    // Old exchange row (will be pruned)
    fakeSupabase._tables.eris_episodic_memories.push({
      id: "stale",
      bot_id: "test-eris",
      user_id: "u-stale",
      type: "exchange",
      content: "ancient",
      created_at: new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
    });
    // Overflowing user (will be consolidated). Threshold here defaults to 300
    // but we override via runMemoryMaintenance opts so we don't need to seed
    // 300 rows.
    seedExchanges(110, { userId: "u-fat" });

    const summarize = vi.fn().mockResolvedValue("rolling summary");
    const result = await semantic.runMemoryMaintenance({
      botId: "test-eris",
      threshold: 10,
      batchSize: 100,
      summarize,
    });

    expect(result.pruned).toBe(1);
    expect(result.consolidatedUsers).toBe(1);
  });
});
