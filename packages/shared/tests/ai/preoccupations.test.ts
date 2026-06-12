import { describe, expect, it, vi, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import { createPreoccupations } from "../../src/ai/preoccupations.js";

function createSupabaseMock(initialPreoccupation: any = null) {
  const calls: any[] = [];
  const tableApi = {
    select: vi.fn(() => tableApi),
    eq: vi.fn(() => tableApi),
    maybeSingle: vi.fn(async () => ({ data: initialPreoccupation ? { preoccupation: initialPreoccupation } : null })),
    upsert: vi.fn(async (row: any) => {
      calls.push(row);
      return { data: row, error: null };
    }),
  };
  return {
    client: { from: vi.fn(() => tableApi) },
    tableApi,
    calls,
  };
}

describe("createPreoccupations", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("uses injected random/now hooks and fallback topics", () => {
    const randomValues = [0.99, 0, 1];
    let randomIndex = 0;
    const module = createPreoccupations({
      fallbackTopics: [{ topic: "quilting", flavor: "been sewing tiny squares" }],
      random: () => randomValues[randomIndex++],
      now: () => 1_000,
    });

    const picked = module.pickPreoccupation({});

    expect(picked).toMatchObject({
      topic: "quilting",
      flavor: "been sewing tiny squares",
      source: "fallback",
      startedAt: 1_000,
      lastInjected: 0,
    });
    expect(picked.expiresAt).toBe(1_000 + 8 * 24 * 60 * 60 * 1000);
  });

  it("persists with the injected table, bot id fallback, and save delay", async () => {
    vi.useFakeTimers();
    const supabase = createSupabaseMock();
    const module = createPreoccupations({
      tableName: "custom_personality_learning",
      defaultBotId: "botty",
      fallbackTopics: [{ topic: "maps", flavor: "been staring at road atlases" }],
      getConfig: async () => ({}),
      getSupabase: async () => supabase.client,
      saveDelayMs: 25,
      random: () => 0.99,
      now: () => 5_000,
    });

    await module.tickPreoccupation({});
    expect(supabase.client.from).toHaveBeenLastCalledWith("custom_personality_learning");

    await vi.advanceTimersByTimeAsync(24);
    expect(supabase.tableApi.upsert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(supabase.tableApi.upsert).toHaveBeenCalledTimes(1);
    expect(supabase.calls[0]).toMatchObject({
      id: "botty",
      preoccupation: {
        topic: "maps",
        flavor: "been staring at road atlases",
        source: "fallback",
      },
    });
    expect(typeof supabase.calls[0].updated_at).toBe("string");
  });

  it("builds context with injected source flavors and updates lastInjected", () => {
    const module = createPreoccupations({
      sourceFlavors: { user_topic: "everyone is stuck on this" },
      random: () => 0,
      now: () => 123_456,
    });
    module._setForTest({
      topic: "chess",
      flavor: null,
      source: "user_topic",
      startedAt: 0,
      expiresAt: 999_999,
      lastInjected: 0,
    });

    const ctx = module.buildPreoccupationContext({ chance: 1 });

    expect(ctx).toContain("\"chess\"");
    expect(ctx).toContain("everyone is stuck on this");
    expect(module.getCurrentPreoccupation()?.lastInjected).toBe(123_456);
    module._reset();
  });
});
