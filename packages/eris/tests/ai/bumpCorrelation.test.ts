import { describe, it, expect, beforeEach, vi } from "vitest";

// Fake supabase that backs recordJoinForCorrelation + getJoinCorrelationStats.
const db = {
  bumps: [],       // { guild_id, bumped_at, service }
  joins: [],       // { guild_id, user_id, joined_at, minutes_since_bump, last_bump_at, service }
  bumpsTable: "eris_bumps",
  joinsTable: "eris_bump_joins",
};

function fakeSb() {
  return {
    from(t) {
      const isBumps = t === db.bumpsTable;
      const table = isBumps ? db.bumps : db.joins;
      const q = {
        _filters: [],
        _order: null,
        _limit: null,
        _count: false,
        select(cols, opts) { if (opts?.count) this._count = true; return this; },
        eq(col, val) { this._filters.push(r => r[col] === val); return this; },
        gte(col, val) { this._filters.push(r => r[col] >= val); return this; },
        order(col, opts) { this._order = { col, asc: opts?.ascending }; return this; },
        limit(n) { this._limit = n; return this; },
        async then(resolve) {
          let data = table.filter(r => this._filters.every(f => f(r)));
          if (this._order) {
            const { col, asc } = this._order;
            data = [...data].sort((a, b) => asc ? (a[col] > b[col] ? 1 : -1) : (a[col] < b[col] ? 1 : -1));
          }
          if (this._limit) data = data.slice(0, this._limit);
          if (this._count) return resolve({ count: data.length, error: null });
          resolve({ data, error: null });
        },
        async insert(row) {
          table.push(row);
          return { error: null };
        },
      };
      return q;
    },
  };
}

vi.mock("../../database.js", () => ({ getSupabase: () => fakeSb() }));

// @ts-expect-error
import * as correlation from "../../ai/bumpCorrelation.js";

beforeEach(() => {
  db.bumps.length = 0;
  db.joins.length = 0;
});

describe("bumpCorrelation.recordJoinForCorrelation", () => {
  it("does nothing when no bump exists", async () => {
    const r = await correlation.recordJoinForCorrelation({ guildId: "g1", userId: "u1" });
    expect(r.attributed).toBe(false);
    expect(db.joins).toHaveLength(1);
    expect(db.joins[0].minutes_since_bump).toBeNull();
  });

  it("attributes the join when a bump is within the window", async () => {
    const now = Date.now();
    db.bumps.push({ guild_id: "g1", bumped_at: new Date(now - 5 * 60_000).toISOString(), service: "disboard" });
    const r = await correlation.recordJoinForCorrelation({ guildId: "g1", userId: "u1", joinedAtMs: now });
    expect(r.attributed).toBe(true);
    expect(r.minutesSinceBump).toBe(5);
    expect(db.joins[0].service).toBe("disboard");
  });

  it("does NOT attribute when the bump is older than the window", async () => {
    const now = Date.now();
    db.bumps.push({ guild_id: "g1", bumped_at: new Date(now - 30 * 60_000).toISOString(), service: "disboard" });
    const r = await correlation.recordJoinForCorrelation({ guildId: "g1", userId: "u1", joinedAtMs: now });
    expect(r.attributed).toBe(false);
    expect(r.minutesSinceBump).toBe(30);
  });

  it("ignores negative time deltas (clock skew)", async () => {
    const now = Date.now();
    db.bumps.push({ guild_id: "g1", bumped_at: new Date(now + 60_000).toISOString(), service: "disboard" });
    const r = await correlation.recordJoinForCorrelation({ guildId: "g1", userId: "u1", joinedAtMs: now });
    expect(r.attributed).toBe(false);
    expect(db.joins[0].minutes_since_bump).toBeNull();
  });
});

describe("bumpCorrelation.getJoinCorrelationStats", () => {
  it("returns zeroed stats when no joins", async () => {
    const s = await correlation.getJoinCorrelationStats("g1", { periodDays: 14 });
    expect(s.totalJoins).toBe(0);
    expect(s.postBumpJoins).toBe(0);
    expect(s.postBumpRatio).toBe(0);
  });

  it("computes ratio and avg correctly", async () => {
    const recent = new Date().toISOString();
    db.bumps.push({ guild_id: "g1", bumped_at: recent, service: "disboard" });
    db.bumps.push({ guild_id: "g1", bumped_at: recent, service: "disboard" });
    db.joins.push({ guild_id: "g1", user_id: "u1", joined_at: recent, minutes_since_bump: 3 });
    db.joins.push({ guild_id: "g1", user_id: "u2", joined_at: recent, minutes_since_bump: 10 });
    db.joins.push({ guild_id: "g1", user_id: "u3", joined_at: recent, minutes_since_bump: 60 });
    const s = await correlation.getJoinCorrelationStats("g1", { periodDays: 14 });
    expect(s.totalJoins).toBe(3);
    expect(s.postBumpJoins).toBe(2);
    expect(s.postBumpRatio).toBeCloseTo(2 / 3, 4);
    expect(s.avgJoinsPerBump).toBe(1); // 2 attributed joins / 2 bumps
    expect(s.windowMinutes).toBe(15);
  });
});
