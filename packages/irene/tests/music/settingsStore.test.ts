// Regression — soundboard, DJ-role, and wake-word settings used to be
// in-memory-only and reset on every restart. settingsStore.js persists them
// to a `music_settings` Supabase table and degrades to in-memory when Supabase
// (or the table) is absent. These tests cover the round-trip through a fake
// Supabase and the in-memory fallback.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Fake Supabase ───────────────────────────────────────────────────────────
// Minimal in-memory store keyed by guild_id. Implements only the chains
// settingsStore.js touches:
//   from("music_settings").select("data").eq("guild_id", id).maybeSingle()
//   from("music_settings").upsert({ guild_id, data, updated_at }, { onConflict })
const store = new Map<string, any>();
// When set, the next select/upsert returns this error (e.g. schema-missing).
let forcedError: any = null;

function fakeSupabase() {
  return {
    from(table: string) {
      if (table !== "music_settings") throw new Error(`unexpected table: ${table}`);
      return {
        _filter: null as string | null,
        select() {
          return {
            eq(_col: string, val: string) {
              return {
                async maybeSingle() {
                  if (forcedError) return { data: null, error: forcedError };
                  const row = store.get(val);
                  return { data: row ? { data: row } : null, error: null };
                },
              };
            },
          };
        },
        async upsert(row: any) {
          if (forcedError) return { error: forcedError };
          store.set(row.guild_id, row.data);
          return { error: null };
        },
      };
    },
  };
}

// getSupabase is what the store calls. We swap its return per-test.
let supabaseClient: any = null;
vi.mock("../../database.js", () => ({
  getSupabase: () => supabaseClient,
}));
vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));

import * as settingsStore from "../../music/settingsStore.js";

beforeEach(() => {
  store.clear();
  forcedError = null;
  supabaseClient = null;
  settingsStore._resetForTest();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("settingsStore — durable music/voice settings", () => {
  it("round-trips DJ role, wake word, and soundboard through Supabase", async () => {
    supabaseClient = fakeSupabase();

    settingsStore.setDjRole("g1", "role-123");
    settingsStore.setWakeWord("g1", "jarvis");
    settingsStore.setSoundboard("g1", { airhorn: { url: "https://x/a.mp3", category: null, duration: null } });

    // Let the background upsert promises settle.
    await new Promise((r) => setTimeout(r, 0));

    // Reset in-memory state and re-hydrate from the fake DB — simulates a restart.
    settingsStore._resetForTest();
    const loaded = await settingsStore.loadGuild("g1");

    expect(loaded.djRole).toBe("role-123");
    expect(loaded.wakeWord).toBe("jarvis");
    expect(loaded.soundboard).toEqual({ airhorn: { url: "https://x/a.mp3", category: null, duration: null } });
    // Synchronous getters read from the now-hydrated cache.
    expect(settingsStore.getDjRole("g1")).toBe("role-123");
    expect(settingsStore.getWakeWord("g1")).toBe("jarvis");
    expect(settingsStore.isDegraded()).toBe(false);
  });

  it("only hits Supabase once per guild on repeated loads", async () => {
    supabaseClient = fakeSupabase();
    const fromSpy = vi.spyOn(supabaseClient, "from");

    await settingsStore.loadGuild("g7");
    await settingsStore.loadGuild("g7");
    await settingsStore.loadGuild("g7");

    expect(fromSpy).toHaveBeenCalledTimes(1);
  });

  it("degrades to in-memory when Supabase is not connected", async () => {
    supabaseClient = null; // no Supabase

    settingsStore.setDjRole("g2", "role-999");
    settingsStore.setWakeWord("g2", "computer");

    // Reads still work from the in-memory cache.
    expect(settingsStore.getDjRole("g2")).toBe("role-999");
    expect(settingsStore.getWakeWord("g2")).toBe("computer");

    // loadGuild is a no-op that returns the in-memory value, never throws.
    const loaded = await settingsStore.loadGuild("g2");
    expect(loaded.djRole).toBe("role-999");
    expect(loaded.wakeWord).toBe("computer");
  });

  it("falls back to in-memory and flips degraded when the table is missing", async () => {
    supabaseClient = fakeSupabase();
    // PostgREST "relation does not exist" — migration not applied.
    forcedError = { code: "42P01", message: "relation \"music_settings\" does not exist" };

    const loaded = await settingsStore.loadGuild("g3");
    expect(loaded.djRole).toBeNull();
    expect(settingsStore.isDegraded()).toBe(true);

    // Subsequent writes don't throw and stay in-memory.
    settingsStore.setDjRole("g3", "role-555");
    expect(settingsStore.getDjRole("g3")).toBe("role-555");
  });

  it("retries a later load after a transient (non-schema) failure", async () => {
    supabaseClient = fakeSupabase();
    // Seed a real row so we can prove the retry actually picks it up.
    store.set("g4", { soundboard: {}, djRole: "real-role", wakeWord: "hey" });

    // First load fails transiently (e.g. network/timeout, not a schema error).
    forcedError = { code: "57014", message: "canceling statement due to statement timeout" };
    const firstFromSpy = vi.spyOn(supabaseClient, "from");
    const first = await settingsStore.loadGuild("g4");

    // Degraded NOT flipped (transient ≠ schema-missing) and we served defaults.
    expect(settingsStore.isDegraded()).toBe(false);
    expect(first.djRole).toBeNull();

    // The transient failure must un-hydrate so the next read re-queries.
    forcedError = null;
    const second = await settingsStore.loadGuild("g4");

    expect(firstFromSpy).toHaveBeenCalledTimes(2); // it really re-queried
    expect(second.djRole).toBe("real-role");
    expect(second.wakeWord).toBe("hey");
    expect(settingsStore.getDjRole("g4")).toBe("real-role");
  });

  it("does NOT retry once the table is confirmed missing (schema error)", async () => {
    supabaseClient = fakeSupabase();
    forcedError = { code: "42P01", message: "relation \"music_settings\" does not exist" };
    const fromSpy = vi.spyOn(supabaseClient, "from");

    await settingsStore.loadGuild("g5");
    expect(settingsStore.isDegraded()).toBe(true);

    // A schema-missing error stays hydrated + degraded — no point re-querying
    // a table that was never created. Second load is a pure in-memory no-op.
    await settingsStore.loadGuild("g5");
    expect(fromSpy).toHaveBeenCalledTimes(1);
  });

  it("returns undefined wake word when unset so callers can apply a default", () => {
    expect(settingsStore.getWakeWord("never-seen")).toBeUndefined();
    expect(settingsStore.getDjRole("never-seen")).toBeNull();
    expect(settingsStore.getSoundboard("never-seen")).toEqual({});
  });
});
