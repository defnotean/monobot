import { describe, expect, test, vi } from "vitest";

import { createLongMemory } from "../../src/ai/longmemory.js";

function makeSupabase({ consciousnessRowId = "bot_consciousness", consciousnessData = null } = {}) {
  const upserts: any[] = [];
  const selects: any[] = [];

  const supabase = {
    from(table: string) {
      const state: any = { table, selected: null, id: null };
      return {
        upsert(payload: any) {
          upserts.push({ table, payload });
          return Promise.resolve({ error: null });
        },
        select(columns: string) {
          state.selected = columns;
          return this;
        },
        eq(column: string, value: string) {
          state[column] = value;
          if (column === "id") state.id = value;
          return this;
        },
        single() {
          selects.push({ ...state });
          if (state.id === consciousnessRowId) {
            return Promise.resolve({ data: consciousnessData ? { data: consciousnessData } : null });
          }
          return Promise.resolve({ data: null });
        },
      };
    },
  };

  return { supabase, upserts, selects };
}

describe("createLongMemory", () => {
  test("persists to configured row ids and uses injected bot fallback for semantic context", async () => {
    const db = makeSupabase({
      consciousnessRowId: "custom_consciousness",
      consciousnessData: {
        goals: { short: ["finish the refactor"], medium: [], long: [] },
        reflections: [{ text: "keep the memory layer boring" }],
      },
    });
    const semanticCalls: any[] = [];
    const memory = createLongMemory({
      longMemoryRowId: "custom_long_memory",
      consciousnessRowId: "custom_consciousness",
      defaultBotId: "custom-bot",
      getDatabase: async () => ({ getSupabase: () => db.supabase }),
      getConfig: async () => ({}),
      getSemantic: async () => ({
        searchRelevantMemories: async (...args: any[]) => {
          semanticCalls.push(args);
          return [{ similarity: 0.9, content: "remembered context" }];
        },
        storeEpisode: async () => undefined,
      }),
      getPersonality: async () => ({}),
      getGeminiModel: async () => "test-model",
      now: () => 1_700_000_000_000,
    });

    memory.updateMoodNarrative("focused", "user-1");
    memory.recordEpisode("user-1", "channel-1", { type: "bond", content: "shared a useful test" });
    await memory.flush();

    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].payload.id).toBe("custom_long_memory");
    expect(db.upserts[0].payload.data.moodNarratives).toEqual({ "user-1": "focused" });

    const context = await memory.buildLongTermContext("user-1", "channel-1", "what do you remember?");

    expect(db.selects.some((s) => s.id === "custom_consciousness")).toBe(true);
    expect(semanticCalls[0]).toEqual(["custom-bot", "user-1", "what do you remember?", 3]);
    expect(context).toContain("[MOOD REASON: focused]");
    expect(context).toContain("[YOUR CURRENT ASPIRATIONS: finish the refactor]");
    expect(context).toContain("[SELF-REFLECTION: \"keep the memory layer boring\"]");
    expect(context).toContain("[RELEVANT MEMORIES: \"remembered context\"]");
  });

  test("keeps Eris-style LRU mood cache distinct from Irene-style FIFO mood cache", () => {
    const erisMemory = createLongMemory({
      moodCache: { strategy: "lru", limit: 2 },
      now: () => 1_700_000_000_000,
    });
    erisMemory.updateMoodNarrative("first", "a");
    erisMemory.updateMoodNarrative("second", "b");
    expect(erisMemory.getMoodNarrative("a")).toBe("first");
    erisMemory.updateMoodNarrative("third", "c");

    expect(erisMemory.getMoodNarrative("a")).toBe("first");
    expect(erisMemory.getMoodNarrative("b")).toBe("");
    erisMemory._internal.reset();

    const ireneMemory = createLongMemory({
      moodCache: { strategy: "fifo", limit: 2 },
      now: () => 1_700_000_000_000,
    });
    ireneMemory.updateMoodNarrative("first", "a");
    ireneMemory.updateMoodNarrative("second", "b");
    expect(ireneMemory.getMoodNarrative("a")).toBe("first");
    ireneMemory.updateMoodNarrative("third", "c");

    expect(ireneMemory.getMoodNarrative("a")).toBe("");
    expect(ireneMemory.getMoodNarrative("b")).toBe("second");
    ireneMemory._internal.reset();
  });

  test("can preserve Irene's uncapped inferMoodNarrative writes", () => {
    const memory = createLongMemory({
      moodCache: { strategy: "fifo", limit: 1 },
      capMoodOnInfer: false,
      now: () => 1_700_000_000_000,
    });

    memory.inferMoodNarrative("first bad thing", "oof", -0.6, "u1");
    memory.inferMoodNarrative("second bad thing", "oof", -0.6, "u2");

    expect(memory.getMoodNarrative("u1")).toContain("first bad thing");
    expect(memory.getMoodNarrative("u2")).toContain("second bad thing");
    memory._internal.reset();
  });

  test("supports bot-specific thought dedupe and extraction modes", () => {
    const jaccardMemory = createLongMemory({
      thoughtDedupeMode: "jaccard",
      thoughtExtractionMode: "clause",
      now: () => 1_700_000_000_000,
    });
    jaccardMemory.addThought("alice said the meeting was weird because schedule shifted");
    jaccardMemory.addThought("alice said the meeting was weird but dinner was excellent");

    expect(jaccardMemory.getMonologue()).toHaveLength(2);
    jaccardMemory.extractThoughts("yeah, i was thinking about cooking earlier");
    expect(jaccardMemory.getMonologue()).toHaveLength(2);
    jaccardMemory._internal.reset();

    const prefixMemory = createLongMemory({
      thoughtDedupeMode: "prefix",
      thoughtExtractionMode: "anywhere",
      now: () => 1_700_000_000_000,
    });
    prefixMemory.addThought("alice said the meeting was weird because schedule shifted");
    prefixMemory.addThought("alice said the meeting was weird but dinner was excellent");

    expect(prefixMemory.getMonologue()).toHaveLength(1);
    prefixMemory.extractThoughts("yeah, i was thinking about cooking earlier");
    expect(prefixMemory.getMonologue()).toHaveLength(2);
    prefixMemory._internal.reset();
  });

  test("uses injected Gemini model getter when generating inner thoughts", async () => {
    const generateContent = vi.fn(async () => ({
      candidates: [{ content: { parts: [{ text: "Eris made a mental note to follow up" }] } }],
    }));
    const memory = createLongMemory({
      defaultBotName: "Eris",
      getGeminiModel: async () => "gemini-test-model",
      random: () => 0,
      now: () => 1_700_000_000_000,
    });

    await memory.generateInnerThought(
      "that helped",
      "glad it helped",
      "June",
      { models: { generateContent } },
    );

    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-test-model" }));
    expect(memory.getMonologue().map((t: any) => t.thought)).toEqual(["Eris made a mental note to follow up"]);
    memory._internal.reset();
  });

  test("honors semantic logging policy", async () => {
    const log = vi.fn();
    const memory = createLongMemory({
      defaultBotId: "irene",
      getConfig: async () => ({}),
      getSemantic: async () => ({
        storeEpisode: async () => { throw new Error("semantic down"); },
        searchRelevantMemories: async () => [],
      }),
      semanticLogging: "log",
      log,
      now: () => 1_700_000_000_000,
    });

    await memory.analyzeExchange("u1", "c1", "thank you", "you're the best", 0.8);
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith("[LongMemory] storeEpisode failed: semantic down");
    memory._internal.reset();
  });
});
