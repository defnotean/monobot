import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  failFlush: false,
  upserts: [] as Array<{ table: string; payload: unknown }>,
}));

function makeChain(table: string): any {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: null, error: null }),
    upsert: async (payload: unknown) => {
      state.upserts.push({ table, payload });
      if (state.failFlush) throw new Error("simulated durable store unreachable");
      return { data: null, error: null };
    },
    then: (resolve: any) => resolve({ data: [], error: null }),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeChain(table),
  }),
}));

vi.mock("../../config.js", () => ({
  default: {
    supabaseEnabled: true,
    requirePersistence: false,
    supabaseUrl: "https://test.supabase.co",
    supabaseKey: "test-key",
  },
}));

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
}));

// @ts-expect-error JS module without types
import { initDatabase, updateMood } from "../../database.js";

describe("Eris debounced flush retry", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    state.failFlush = false;
    state.upserts.length = 0;
    await initDatabase();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reschedules a failed bucket and retries it without a new save()", async () => {
    state.failFlush = true;

    updateMood(7, 50);
    await vi.advanceTimersByTimeAsync(200);

    expect(state.upserts.filter((u) => u.table === "eris_mood")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    state.failFlush = false;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(state.upserts.filter((u) => u.table === "eris_mood")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
