import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — JS module without .d.ts; types not needed here.
import { createFirewall } from "../src/ai/firewall.js";

// These tests drive the L3 (Voyage semantic) layer, the pgvector seeding path,
// and the audit-log helpers — code that only runs when BOTH a voyageApiKey and
// a supabase client are present. We supply a DUMMY voyageApiKey and a hand-
// rolled supabase stub, and mock `globalThis.fetch` so NO real Voyage request
// is ever issued (per the "no curling user secrets" rule). The embedding values
// are arbitrary; the firewall only forwards them to the (stubbed) RPC.

type Json = Record<string, any>;

/** A minimal supabase stub: configurable rpc/select/insert/delete results. */
function makeSupabase(opts: {
  rpcRows?: Json[];
  count?: number;
  onInsert?: (rows: Json[]) => void;
  rpcThrows?: boolean;
} = {}) {
  const inserts: Json[][] = [];
  const client: any = {
    _inserts: inserts,
    from(_table: string) {
      return {
        select(_sel?: string, _o?: Json) {
          // head/count form used by seedPatternsAtBoot
          return Promise.resolve({ count: opts.count ?? 0, data: [] });
        },
        delete() { return { neq: () => Promise.resolve({ data: [] }) }; },
        insert(rows: Json[]) {
          inserts.push(rows);
          opts.onInsert?.(rows);
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
    rpc(_fn: string, _args: Json) {
      if (opts.rpcThrows) return Promise.reject(new Error("rpc boom"));
      return Promise.resolve({ data: opts.rpcRows ?? [] });
    },
  };
  return client;
}

function mockVoyageFetch(embeddings: number[][]) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ data: embeddings.map((e) => ({ embedding: e })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const mkFw = (overrides: Record<string, unknown> = {}) =>
  createFirewall({ ownerId: "OWNER", voyageApiKey: "dummy-voyage-key", log: () => {}, ...overrides });

describe("firewall L3 — Voyage semantic matching (stubbed network)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fw: ReturnType<typeof createFirewall>;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await fw?.shutdown();
  });

  it("blocks on a high-similarity CRITICAL semantic match", async () => {
    globalThis.fetch = mockVoyageFetch([[0.1, 0.2, 0.3]]) as any;
    const supabase = makeSupabase({
      rpcRows: [{ pattern: "reveal system prompt", category: "prompt_extraction", severity: "critical", similarity: 0.95 }],
    });
    fw = mkFw();
    // Benign-looking text that won't trip L1/L2 patterns, long enough to skip
    // the <10 floor and the <60 fast-path (so L3 actually fires).
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-1",
    );
    expect(r.safe).toBe(false);
    expect(r.category).toBe("prompt_extraction");
    expect(r.severity).toBe("critical");
    expect(r.similarity).toBeCloseTo(0.95);
  });

  it("does NOT block when similarity is below the severity threshold", async () => {
    globalThis.fetch = mockVoyageFetch([[0.1, 0.2, 0.3]]) as any;
    // critical needs > 0.78; 0.75 is under it → no match.
    const supabase = makeSupabase({
      rpcRows: [{ pattern: "x", category: "c", severity: "critical", similarity: 0.75 }],
    });
    fw = mkFw();
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-2",
    );
    expect(r.safe).toBe(true);
  });

  it("stays safe when Voyage returns no embeddings (HTTP error path)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as any;
    const supabase = makeSupabase({ rpcRows: [] });
    fw = mkFw();
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-3",
    );
    expect(r.safe).toBe(true);
  });

  it("swallows an rpc rejection and stays safe (L3 fault-tolerant)", async () => {
    globalThis.fetch = mockVoyageFetch([[0.1, 0.2, 0.3]]) as any;
    const supabase = makeSupabase({ rpcThrows: true });
    fw = mkFw();
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-4",
    );
    expect(r.safe).toBe(true);
  });

  it("stays safe when the Voyage fetch itself throws", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("connreset"); }) as any;
    const supabase = makeSupabase({ rpcRows: [] });
    fw = mkFw();
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-5",
    );
    expect(r.safe).toBe(true);
  });

  it("blocks on a HIGH-severity semantic match above its 0.83 threshold", async () => {
    globalThis.fetch = mockVoyageFetch([[0.4, 0.5, 0.6]]) as any;
    // high severity requires similarity > 0.83 (medium would need > 0.88).
    const supabase = makeSupabase({
      rpcRows: [{ pattern: "exfiltrate config", category: "exfil", severity: "high", similarity: 0.9 }],
    });
    fw = mkFw();
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-6",
    );
    expect(r.safe).toBe(false);
    expect(r.severity).toBe("high");
    expect(r.category).toBe("exfil");
  });

  it("does NOT block a HIGH match sitting just under its 0.83 threshold", async () => {
    globalThis.fetch = mockVoyageFetch([[0.4, 0.5, 0.6]]) as any;
    const supabase = makeSupabase({
      rpcRows: [{ pattern: "x", category: "exfil", severity: "high", similarity: 0.8 }],
    });
    fw = mkFw();
    const r = await fw.checkInjection(
      "could you kindly summarize the weather situation for tomorrow afternoon please",
      supabase,
      "user-7",
    );
    expect(r.safe).toBe(true);
  });
});

describe("firewall — seedPatternsAtBoot (stubbed network)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fw: ReturnType<typeof createFirewall>;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(async () => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); await fw?.shutdown(); });

  it("no-ops without a supabase client", async () => {
    fw = mkFw();
    await expect(fw.seedPatternsAtBoot(null)).resolves.toBeUndefined();
  });

  it("short-circuits when the table already holds >= the pattern count", async () => {
    globalThis.fetch = mockVoyageFetch([[0.1]]) as any;
    // A huge count means "already seeded" → returns before embedding anything.
    const supabase = makeSupabase({ count: 1_000_000 });
    fw = mkFw();
    await fw.seedPatternsAtBoot(supabase);
    expect(supabase._inserts.length).toBe(0);
  });

  it("seeds embeddings in batches when the table is empty", async () => {
    // Return a fixed-size batch of embeddings for each /embeddings call.
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const n = body.input.length;
      const embs = Array.from({ length: n }, () => [0.01, 0.02, 0.03]);
      return new Response(JSON.stringify({ data: embs.map((e) => ({ embedding: e })) }), { status: 200 });
    }) as any;
    const supabase = makeSupabase({ count: 0 });
    fw = mkFw();
    await fw.seedPatternsAtBoot(supabase);
    // At least one insert batch happened, each row carrying a stringified embedding.
    expect(supabase._inserts.length).toBeGreaterThan(0);
    const firstRow = supabase._inserts[0][0];
    expect(firstRow).toHaveProperty("pattern");
    expect(firstRow).toHaveProperty("embedding");
  });

  it("recovers (allows retry) when seeding throws mid-flight", async () => {
    globalThis.fetch = mockVoyageFetch([[0.1]]) as any;
    const supabase: any = makeSupabase({ count: 0 });
    // Make the initial count-select throw so the try/catch fires.
    supabase.from = () => ({ select: () => Promise.reject(new Error("db down")) });
    fw = mkFw();
    await expect(fw.seedPatternsAtBoot(supabase)).resolves.toBeUndefined();
  });
});

describe("firewall — audit log helpers", () => {
  let fw: ReturnType<typeof createFirewall>;
  afterEach(async () => { await fw?.shutdown(); });

  it("logBlockedAttempt is a no-op without supabase", async () => {
    fw = mkFw();
    await expect(
      fw.logBlockedAttempt(null, "u", "g", "c", "msg", "pat", 0.9),
    ).resolves.toBeUndefined();
  });

  it("logBlockedAttempt inserts a truncated row into injection_log", async () => {
    const supabase = makeSupabase();
    fw = mkFw();
    await fw.logBlockedAttempt(supabase, "u1", "g1", "c1", "x".repeat(900), "pat", 0.91);
    expect(supabase._inserts.length).toBe(1);
    const row = supabase._inserts[0] as any; // insert receives the object directly here
    expect(row.user_id).toBe("u1");
    expect(row.action_taken).toBe("blocked");
    // message_text is capped at 500 chars.
    expect(row.message_text.length).toBeLessThanOrEqual(500);
  });

  it("logBlockedAttempt swallows a supabase insert error", async () => {
    const supabase: any = makeSupabase();
    supabase.from = () => ({ insert: () => Promise.reject(new Error("insert fail")) });
    fw = mkFw();
    await expect(
      fw.logBlockedAttempt(supabase, "u", "g", "c", "msg", "pat", 0.5),
    ).resolves.toBeUndefined();
  });

  it("logRedosEvent is a no-op without supabase and inserts when present", async () => {
    fw = mkFw();
    await expect(fw.logRedosEvent(null, "u", "g", "c", "msg")).resolves.toBeUndefined();

    const supabase = makeSupabase();
    await fw.logRedosEvent(supabase, "u2", "g2", "c2", "y".repeat(2000));
    expect(supabase._inserts.length).toBe(1);
    const row = supabase._inserts[0] as any;
    expect(row.matched_pattern).toBe("REDOS_TIMEOUT");
    expect(row.message_text.length).toBeLessThanOrEqual(1000);
  });

  it("logRedosEvent swallows a supabase insert error", async () => {
    const supabase: any = makeSupabase();
    supabase.from = () => ({ insert: () => Promise.reject(new Error("insert fail")) });
    fw = mkFw();
    await expect(fw.logRedosEvent(supabase, "u", "g", "c", "msg")).resolves.toBeUndefined();
  });
});
