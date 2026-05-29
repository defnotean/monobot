// Fact-cap regression — the 20-fact cap + dedup live in ai/memory.js's
// addMemory, but the actual write path (memoryExecutor remember_fact) called
// db.saveFact directly and bypassed the cap entirely, so facts grew unbounded.
// remember_fact now routes through addMemory; this suite proves the cap holds.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Fact = { id: string; fact_text: string; sensitivity: string };

let store: Fact[];
let _autoId: number;

// In-memory fake of the facts table. getFacts returns newest-first (the
// eris-economy stream owns that ordering in database.js; we assume it here per
// the task note). saveFact appends. The optional `limit` mirrors the real
// signature so addMemory's `getFacts(userId, MAX_PER_USER)` is bounded the same
// way the real query is.
vi.mock("../../../database.js", () => ({
  getFacts: vi.fn(async (_userId: string, limit = 20) => {
    const newestFirst = [...store].reverse();
    return newestFirst.slice(0, limit);
  }),
  saveFact: vi.fn(async (_userId: string, factText: string, sensitivity = "normal") => {
    store.push({ id: String(_autoId++), fact_text: factText, sensitivity });
    return true;
  }),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/memoryExecutor.js";

const fakeMessage = { author: { id: "u-cap-test" } } as any;

beforeEach(() => {
  store = [];
  _autoId = 1;
});

describe("remember_fact enforces the 20-fact cap via addMemory", () => {
  it("stops storing once the cap is reached and reports memory full", async () => {
    // Write 25 facts through the executor path, each built from a UNIQUE pool of
    // words so neither the executor's >70% word-overlap dedup nor addMemory's
    // substring dedup fire — every write is a genuinely new fact.
    const subjects = [
      "ferrets", "kayaking", "saxophone", "linguistics", "origami",
      "volcanoes", "espresso", "chessboards", "meteorites", "bonsai",
      "calligraphy", "wetsuits", "telescopes", "harmonicas", "lanterns",
      "tapestries", "marathons", "submarines", "cathedrals", "glaciers",
      "fireflies", "windmills", "labyrinths", "constellations", "waterfalls",
    ];
    const results: string[] = [];
    for (let i = 0; i < 25; i++) {
      const out = await execute(
        "remember_fact",
        { fact: `enjoys ${subjects[i]}` },
        fakeMessage,
        {},
      );
      results.push(out as string);
    }

    // Cap is 20 — never more, even though we attempted 25 writes.
    expect(store.length).toBe(20);

    // The first 20 succeeded; the rest were rejected with the cap message.
    const remembered = results.filter(r => r.startsWith("remembered:"));
    const rejected = results.filter(r => /memory full/i.test(r));
    expect(remembered).toHaveLength(20);
    expect(rejected.length).toBe(5);
  });

  it("a single write below the cap still goes through and persists", async () => {
    const out = await execute(
      "remember_fact",
      { fact: "likes pineapple on pizza apparently" },
      fakeMessage,
      {},
    );
    expect(out).toBe("remembered: likes pineapple on pizza apparently");
    expect(store).toHaveLength(1);
    expect(store[0].fact_text).toBe("likes pineapple on pizza apparently");
  });
});
