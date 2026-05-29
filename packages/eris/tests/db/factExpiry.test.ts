// Sensitive-fact TTL regression — privacy: an optional expiry for
// sensitive-tier facts so emotional disclosures the user flagged "sensitive"
// don't necessarily live forever. Proves:
//   - saveFact stamps expires_at only for sensitive-tier facts when
//     SENSITIVE_FACT_TTL_DAYS is set
//   - the expires_at column-missing path degrades to a legacy (no-expiry) row
//     (mirrors the queueLocalCommand pre-migration latch)
//   - getFacts hides already-expired facts from context even before the cron
//     sweeps them
//   - pruneExpiredFacts deletes expired rows, no-ops when the column is absent

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_KEY = "test-anon-key-not-real";
  process.env.SENSITIVE_FACT_TTL_DAYS = "30";
});

type FactRow = {
  id?: string;
  user_id?: string;
  fact_text?: string;
  sensitivity?: string;
  importance?: string;
  expires_at?: string | null;
  created_at?: string;
};

const facts: FactRow[] = [];
const inserts: FactRow[] = [];
// When true the table is pre-migration-006: an insert carrying expires_at is
// rejected with the PostgREST "column not found" error.
let preMigration = false;
let _autoId = 1;

function makeFactsChain() {
  return {
    insert(row: FactRow) {
      inserts.push({ ...row });
      if (preMigration && "expires_at" in row) {
        return Promise.resolve({
          data: null,
          error: { code: "PGRST204", message: "Could not find the 'expires_at' column of 'eris_facts' in the schema cache" },
        });
      }
      facts.push({ id: String(_autoId++), created_at: new Date().toISOString(), ...row });
      return Promise.resolve({ data: null, error: null });
    },
    select(_cols: string) {
      const filters: Array<(r: FactRow) => boolean> = [];
      let order: { col: keyof FactRow; descending: boolean } | null = null;
      let limit = Infinity;
      const builder: any = {
        eq(col: keyof FactRow, val: unknown) { filters.push(r => r[col] === val); return builder; },
        order(col: keyof FactRow, o?: { ascending?: boolean }) { order = { col, descending: o?.ascending === false }; return builder; },
        limit(n: number) { limit = n; return builder; },
        then(resolve: (v: { data: FactRow[]; error: null }) => unknown) {
          let rows = facts.filter(r => filters.every(f => f(r)));
          if (order) {
            const { col, descending } = order!;
            rows = [...rows].sort((a, b) => {
              const av = String(a[col] ?? ""); const bv = String(b[col] ?? "");
              return descending ? bv.localeCompare(av) : av.localeCompare(bv);
            });
          }
          if (Number.isFinite(limit)) rows = rows.slice(0, limit);
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
    delete() {
      const filters: Array<(r: FactRow) => boolean> = [];
      const builder: any = {
        eq(col: keyof FactRow, val: unknown) { filters.push(r => r[col] === val); return builder; },
        not(col: keyof FactRow, _op: string, _val: unknown) { filters.push(r => r[col] != null); return builder; },
        lt(col: keyof FactRow, val: unknown) { filters.push(r => String(r[col] ?? "") < String(val)); return builder; },
        then(resolve: (v: { count: number; error: null }) => unknown) {
          const before = facts.length;
          const survivors = facts.filter(r => !filters.every(f => f(r)));
          const removed = before - survivors.length;
          facts.length = 0; facts.push(...survivors);
          return resolve({ count: removed, error: null });
        },
      };
      return builder;
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
      if (table === "eris_facts") return makeFactsChain();
      return makeNoopChain();
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeMockSupabase() }));

const ISO = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;

let db: any;

describe("sensitive-fact TTL", () => {
  beforeEach(async () => {
    facts.length = 0;
    inserts.length = 0;
    preMigration = false;
    _autoId = 1;
    // Module-level latch (_factExpiryColAvailable) survives across it-blocks —
    // reset modules so each test starts with a fresh latch.
    vi.resetModules();
    db = await import("../../database.js");
    await db.initDatabase();
  });

  it("stamps expires_at on sensitive facts but not normal/secret", async () => {
    await db.saveFact("u1", "casual fact", "normal");
    await db.saveFact("u1", "i struggle with anxiety", "sensitive");
    await db.saveFact("u1", "i have a secret crush", "secret");

    const normal = inserts.find(r => r.fact_text === "casual fact")!;
    const sensitive = inserts.find(r => r.fact_text === "i struggle with anxiety")!;
    const secret = inserts.find(r => r.fact_text === "i have a secret crush")!;

    expect(normal.expires_at).toBeUndefined();
    expect(secret.expires_at).toBeUndefined();
    expect(typeof sensitive.expires_at).toBe("string");
    // ~30 days out
    const ms = Date.parse(sensitive.expires_at as string) - Date.now();
    expect(ms).toBeGreaterThan(29 * DAY);
    expect(ms).toBeLessThan(31 * DAY);
  });

  it("degrades to a legacy (no-expiry) insert when the column is missing", async () => {
    preMigration = true;
    const ok = await db.saveFact("u1", "i struggle with anxiety", "sensitive");
    expect(ok).toBe(true);
    // Two inserts: the expires_at attempt (rejected) then the legacy retry.
    expect(inserts.length).toBe(2);
    expect("expires_at" in inserts[0]).toBe(true);
    expect("expires_at" in inserts[1]).toBe(false);
    // Row was persisted via the retry.
    expect(facts).toHaveLength(1);
    expect(facts[0].expires_at).toBeUndefined();
  });

  it("getFacts hides facts whose expires_at has already passed", async () => {
    facts.push(
      { id: "live", user_id: "u1", fact_text: "still valid", sensitivity: "sensitive", expires_at: ISO(5 * DAY), created_at: ISO(-DAY) },
      { id: "dead", user_id: "u1", fact_text: "long expired", sensitivity: "sensitive", expires_at: ISO(-DAY), created_at: ISO(-10 * DAY) },
      { id: "forever", user_id: "u1", fact_text: "no expiry", sensitivity: "normal", expires_at: null, created_at: ISO(-2 * DAY) },
    );

    const out = await db.getFacts("u1");
    const texts = out.map((f: FactRow) => f.fact_text).sort();
    expect(texts).toEqual(["no expiry", "still valid"]);
    expect(texts).not.toContain("long expired");
  });

  it("pruneExpiredFacts deletes elapsed rows", async () => {
    facts.push(
      { id: "live", user_id: "u1", fact_text: "valid", sensitivity: "sensitive", expires_at: ISO(5 * DAY) },
      { id: "dead", user_id: "u1", fact_text: "expired", sensitivity: "sensitive", expires_at: ISO(-DAY) },
      { id: "forever", user_id: "u1", fact_text: "normal", sensitivity: "normal", expires_at: null },
    );
    const res = await db.pruneExpiredFacts();
    expect(res.deleted).toBe(1);
    expect(facts.map(f => f.id).sort()).toEqual(["forever", "live"]);
  });

  it("getFactsGlobal also hides already-expired facts (parity with getFacts)", async () => {
    facts.push(
      { id: "live", user_id: "u1", fact_text: "still valid", sensitivity: "sensitive", expires_at: ISO(5 * DAY), created_at: ISO(-DAY) },
      { id: "dead", user_id: "u1", fact_text: "long expired", sensitivity: "sensitive", expires_at: ISO(-DAY), created_at: ISO(-10 * DAY) },
      { id: "forever", user_id: "u1", fact_text: "no expiry", sensitivity: "normal", expires_at: null, created_at: ISO(-2 * DAY) },
    );

    const out = await db.getFactsGlobal("u1");
    const texts = out.map((f: FactRow) => f.fact_text).sort();
    expect(texts).toEqual(["no expiry", "still valid"]);
    expect(texts).not.toContain("long expired");
  });
});
