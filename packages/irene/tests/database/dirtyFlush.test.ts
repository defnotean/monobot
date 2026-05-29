import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Fake Supabase ───────────────────────────────────────────────────────────
//
// Models only the chains database.js#_flushSave touches:
//   from("bot_data").upsert({ id, data })   — the legacy whole-blob write.
// Records every upsert payload so a test can assert what landed.
//
// initDatabase isn't exercised here — we inject this client directly via the
// _internal test hook so save()/flushNow engage without a live connection.

interface Upsert { id: string; data: any; }
const upserts: Upsert[] = [];
let upsertError: { message: string } | null = null;

function fakeSupabase() {
  return {
    from(table: string) {
      if (table !== "bot_data") throw new Error(`fakeSupabase: unexpected table "${table}"`);
      return {
        async upsert(payload: Upsert) {
          // Deep-clone so later in-memory mutations can't retroactively change
          // what the test thinks was written.
          upserts.push({ id: payload.id, data: JSON.parse(JSON.stringify(payload.data)) });
          return { error: upsertError };
        },
      };
    },
  };
}

// ─── Mocks — config flag + saga + perEntity ──────────────────────────────────
// Mirror dualWriteSaga.test.ts: control dualWritePersistence, stub the saga
// replayer, and capture the per-entity fanout so we can assert which entities
// (and which guilds) were written.

let mockDualWriteFlag = false;
vi.mock("../../config.js", () => ({
  default: {
    get dualWritePersistence() { return mockDualWriteFlag; },
    botName: "irene-test",
    supabaseEnabled: true,
  },
}));

vi.mock("../../sagaReplayer.js", () => ({
  createSaga: async () => "saga-test",
  markSagaLeg: async () => {},
}));

// Capture per-entity writes. Each helper records (guildId | "<bot>") so a test
// can assert that an unrelated guild's row was NOT written.
const peWrites = {
  guildSettings: [] as string[],
  customCommands: [] as string[],
  globalState: 0,
  flushNowCalls: 0,
};
vi.mock("../../database/perEntity.js", () => ({
  writeGuildSettings: async (gid: string) => { peWrites.guildSettings.push(gid); },
  writeCustomCommands: async (gid: string) => { peWrites.customCommands.push(gid); },
  writeScrimStats: async () => {},
  writeStarboardEntries: async () => {},
  writeSavedQueue: async () => {},
  writeMoodState: async () => {},
  writeRelationships: async () => {},
  writeGlobalState: async () => { peWrites.globalState++; },
  flushPerEntityNow: async () => { peWrites.flushNowCalls++; },
}));

import * as db from "../../database.js";

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  upserts.length = 0;
  upsertError = null;
  mockDualWriteFlag = false;
  peWrites.guildSettings = [];
  peWrites.customCommands = [];
  peWrites.globalState = 0;
  peWrites.flushNowCalls = 0;
  db._internal.__resetForTest();
  db._internal.__setSupabaseForTest(fakeSupabase());
});

afterEach(() => {
  db._internal.__resetForTest();
});

// ─── (a) Dirty-set: one guild's change marks only that slice ─────────────────

describe("dirty-set partial flush", () => {
  it("setGuildSetting marks only the guild_settings slice dirty", () => {
    db.setGuildSetting("g1", "log_channel", "c1");
    expect([...db._internal.dirty]).toEqual(["guild_settings"]);
  });

  it("a top-level mutation marks only its own slice dirty (not guild_settings)", () => {
    db.addWarning("g1", "u1", "mod1", "spam");
    expect([...db._internal.dirty]).toEqual(["warnings"]);
  });

  it("flushing a single-guild edit fans out ONLY that guild's per-entity row", async () => {
    mockDualWriteFlag = true;
    // Seed two guilds so the cache (and thus the blob) holds both.
    db.setGuildSetting("g1", "log_channel", "c1");
    db.setGuildSetting("g2", "log_channel", "c2");
    await db._internal.flushSave();
    // Both guilds present in the blob (system of record stays whole)...
    expect(Object.keys(upserts.at(-1)!.data.guild_settings).sort()).toEqual(["g1", "g2"]);
    // ...but the FIRST flush wrote both guild rows (both were dirty together).
    expect(peWrites.guildSettings.sort()).toEqual(["g1", "g2"]);

    // Now change only g2 and flush again: the fanout must touch g2 only,
    // never re-emitting g1's unchanged row.
    peWrites.guildSettings = [];
    db.setGuildSetting("g2", "log_channel", "c2-updated");
    expect([...db._internal.dirty]).toEqual(["guild_settings"]);
    await db._internal.flushSave();
    expect(peWrites.guildSettings).toEqual(["g2"]);
  });

  it("a guild_settings-only flush does NOT re-emit the global_state row", async () => {
    mockDualWriteFlag = true;
    db.setGuildSetting("g1", "log_channel", "c1");
    await db._internal.flushSave();
    expect(peWrites.globalState).toBe(0); // no warnings/reminders/etc. changed
  });

  it("a warnings change DOES emit the global_state row but no guild rows", async () => {
    mockDualWriteFlag = true;
    db.addWarning("g1", "u1", "mod1", "spam");
    await db._internal.flushSave();
    expect(peWrites.globalState).toBe(1);
    expect(peWrites.guildSettings).toEqual([]);
  });

  it("clears the dirty set after a successful flush; a no-op flush writes nothing", async () => {
    db.setGuildSetting("g1", "log_channel", "c1");
    await db._internal.flushSave();
    expect([...db._internal.dirty]).toEqual([]);
    const countAfterFirst = upserts.length;
    await db._internal.flushSave(); // nothing dirty
    expect(upserts.length).toBe(countAfterFirst);
  });

  it("re-marks the dirty slices when the blob upsert fails so they aren't lost", async () => {
    upsertError = { message: "boom" };
    db.setGuildSetting("g1", "log_channel", "c1");
    await db._internal.flushSave();
    // After 3 failed attempts the slice is re-queued for the next debounce.
    expect([...db._internal.dirty]).toEqual(["guild_settings"]);
  });
});

// ─── (a2) Per-guild deletion/prune mutators narrow the dirty-entity set ──────
//
// These functions delete/prune from data.guild_settings[guildId] directly
// (they don't route through ensureGuild), so without an explicit _markEntity
// call they'd leave the dirty-entity set empty → the fanout would defensively
// re-emit EVERY guild's row. Each must register the touched guild so a single-
// guild deletion fans out only that guild's per-entity row.

describe("per-guild deletion mutators narrow the dirty-entity set", () => {
  // For each mutator: a (seed) that creates state on the guild, then the
  // (mutate) under test. We assert the dirty-entity set is scoped to g1 only.
  const cases: Array<{ name: string; seed: (g: string) => void; mutate: () => void }> = [
    {
      name: "removeTrustedUser",
      seed: (g) => db.addTrustedUser(g, "u1"),
      mutate: () => db.removeTrustedUser("g1", "u1"),
    },
    {
      name: "removeReactionRole",
      seed: (g) => db.addReactionRole(g, "m1", "👍", "r1"),
      mutate: () => db.removeReactionRole("g1", "m1", "👍"),
    },
    {
      name: "clearLockdown",
      seed: (g) => db.saveLockdown(g, Date.now() + 60_000),
      mutate: () => db.clearLockdown("g1"),
    },
    {
      name: "clearSlowmode",
      seed: (g) => db.saveSlowmode("c1", g, Date.now() + 60_000),
      mutate: () => db.clearSlowmode("c1", "g1"),
    },
    {
      name: "isUserExempt (lazy prune of expired exemption)",
      seed: (g) => db.addExemption(g, "u1", null, "reason", "mod1", Date.now() - 1000),
      mutate: () => db.isUserExempt("g1", "u1", 1),
    },
  ];

  for (const { name, seed, mutate } of cases) {
    it(`${name} marks ONLY the touched guild dirty (not the empty re-emit-all fallback)`, () => {
      // Seed two guilds so an empty entity set would wrongly re-emit both.
      seed("g1");
      seed("g2");
      db._internal.dirty.clear();
      db._internal.dirtyEntities.clear();

      mutate();

      const set = db._internal.dirtyEntities.get("guild_settings");
      // Non-empty + exactly {g1}: the fanout scopes to g1, never re-emitting g2.
      expect(set && [...set]).toEqual(["g1"]);
    });
  }

  it("getExpiredTempBans marks ONLY guilds whose bans were actually pruned", () => {
    // getExpiredTempBans has no single-guild arg — it sweeps every guild and
    // prunes due bans. g1 has a due ban (pruned → dirty); g2's ban is in the
    // future (untouched → must NOT be re-emitted).
    db.addTempBan("g1", "u1", "User", -1000, "reason", "mod1"); // already due
    db.addTempBan("g2", "u2", "User", 60_000, "reason", "mod1"); // not due yet
    db._internal.dirty.clear();
    db._internal.dirtyEntities.clear();

    db.getExpiredTempBans();

    const set = db._internal.dirtyEntities.get("guild_settings");
    expect(set && [...set]).toEqual(["g1"]);
  });

  it("removeTrustedUser fans out ONLY the touched guild's per-entity row", async () => {
    mockDualWriteFlag = true;
    db.addTrustedUser("g1", "u1");
    db.addTrustedUser("g2", "u2");
    await db._internal.flushSave();
    // Reset capture so we only observe the deletion flush.
    peWrites.guildSettings = [];

    db.removeTrustedUser("g1", "u1");
    await db._internal.flushSave();
    expect(peWrites.guildSettings).toEqual(["g1"]);
  });
});

// ─── (b) flushNow drains everything on shutdown ──────────────────────────────

describe("flushNow shutdown drain", () => {
  it("writes the pending blob and drains the per-entity queue", async () => {
    mockDualWriteFlag = true;
    db.setGuildSetting("g1", "log_channel", "c1");
    db.addWarning("g1", "u1", "mod1", "spam");
    await db.flushNow();
    // Blob landed with both slices reflected.
    const last = upserts.at(-1)!;
    expect(last.id).toBe("irene");
    expect(last.data.guild_settings.g1.log_channel).toBe("c1");
    expect(last.data.warnings.length).toBe(1);
    // Per-entity coalesce queue was drained.
    expect(peWrites.flushNowCalls).toBe(1);
    // Dirty set fully drained.
    expect([...db._internal.dirty]).toEqual([]);
  });

  it("is a no-op (still drains per-entity) when nothing is dirty", async () => {
    mockDualWriteFlag = true;
    await db.flushNow();
    expect(upserts.length).toBe(0);
    expect(peWrites.flushNowCalls).toBe(1);
  });
});

// ─── (c) withUserLock serialises concurrent same-key mutations ───────────────

describe("withUserLock", () => {
  it("serialises two concurrent read-modify-writes against the same key", async () => {
    // Shared counter mutated via a read → await → write sequence. Without the
    // lock the two ops interleave and both read 0, losing one increment.
    let shared = 0;
    const rmw = () => db._internal.withUserLock("u1", async () => {
      const read = shared;
      await new Promise((r) => setTimeout(r, 5)); // force an interleave window
      shared = read + 1;
    });
    await Promise.all([rmw(), rmw()]);
    expect(shared).toBe(2);
  });

  it("does NOT serialise mutations against DIFFERENT keys", async () => {
    const order: string[] = [];
    const slow = db._internal.withUserLock("a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
    });
    const fast = db._internal.withUserLock("b", async () => {
      order.push("b");
    });
    await Promise.all([slow, fast]);
    // Different keys run independently — the fast one finishes first.
    expect(order).toEqual(["b", "a"]);
  });

  it("releases the lock even if the body throws (no deadlock)", async () => {
    await expect(
      db._internal.withUserLock("u1", async () => { throw new Error("nope"); }),
    ).rejects.toThrow("nope");
    // A subsequent op on the same key still runs.
    const ran = await db._internal.withUserLock("u1", async () => "ok");
    expect(ran).toBe("ok");
  });

  it("updateRelationshipLocked serialises concurrent affinity bumps for one user", async () => {
    // Two +10 bumps must sum to +20, not clobber to +10.
    const [a, b] = await Promise.all([
      db.updateRelationshipLocked("u1", 10),
      db.updateRelationshipLocked("u1", 10),
    ]);
    const rel = db.getRelationship("u1");
    expect(rel.affinity_score).toBe(20);
    expect(rel.interactions_count).toBe(2);
    // Each call returns a snapshot reflecting its own bump landing.
    expect(a.affinity_score).toBeLessThanOrEqual(b.affinity_score);
  });
});
