// ─── REFERENCE TOOL TEST ─── Mirror this shape when testing a new tool. Schema: packages/eris/ai/tools.js:427; handler: packages/eris/ai/executors/miscExecutor.js:63. ───
//
// Why this shape:
//   1. Mock ../../database.js BEFORE importing the executor — the executor
//      imports `* as db`, so the mock has to land first or you get the real
//      module (which tries to talk to Supabase).
//   2. Build the smallest plausible `message` object the handler touches.
//      get_mood doesn't read anything off `message`, but the function
//      signature still requires it; hand it an empty object and assert.
//   3. Test the input/output contract — mood values map to specific labels.
//      Don't reach into db state, don't simulate Discord, don't end-to-end.

import { describe, it, expect, vi } from "vitest";

// Mood values we want the test to control. Mutated per-case via setMood().
const moodState = { mood_score: 0, energy: 50 };
function setMood(mood_score: number, energy: number) {
  moodState.mood_score = mood_score;
  moodState.energy = energy;
}

vi.mock("../../database.js", () => ({
  // Only stub what the get_mood handler reaches for. Other db.* methods are
  // not relevant to this tool — keep the mock minimal.
  getMood: () => ({ ...moodState }),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../ai/executors/miscExecutor.js";

// Minimal fake message — get_mood reads nothing off it, but the handler
// signature requires a message argument so we pass a plain object.
const fakeMessage = {} as any;

describe("get_mood tool handler", () => {
  it("returns 'great' mood label when mood_score > 30", async () => {
    setMood(75, 80);
    const result = await execute("get_mood", {}, fakeMessage, {});
    expect(result).toBe("mood: great (75/100) | energy: hyper (80/100)");
  });

  it("returns 'decent' mood label for scores 1..30", async () => {
    setMood(15, 50);
    const result = await execute("get_mood", {}, fakeMessage, {});
    expect(result).toBe("mood: decent (15/100) | energy: normal (50/100)");
  });

  it("returns 'meh' mood label for scores -30..0", async () => {
    setMood(0, 30);
    const result = await execute("get_mood", {}, fakeMessage, {});
    expect(result).toBe("mood: meh (0/100) | energy: tired (30/100)");
  });

  it("returns 'terrible' mood label when mood_score <= -30", async () => {
    setMood(-50, 10);
    const result = await execute("get_mood", {}, fakeMessage, {});
    expect(result).toBe("mood: terrible (-50/100) | energy: tired (10/100)");
  });

  it("classifies energy as 'hyper' above 70", async () => {
    setMood(50, 90);
    const result = await execute("get_mood", {}, fakeMessage, {});
    expect(result).toContain("energy: hyper (90/100)");
  });

  it("ignores any input arguments — get_mood takes none", async () => {
    setMood(20, 60);
    const withArgs = await execute("get_mood", { foo: "bar", user_id: "123" }, fakeMessage, {});
    const withoutArgs = await execute("get_mood", {}, fakeMessage, {});
    expect(withArgs).toBe(withoutArgs);
  });

  it("returns undefined for tools the misc executor does not own", async () => {
    // Sub-executor contract: return undefined when the tool isn't in HANDLED.
    // This lets the main executor fall through to the next sub-executor.
    const result = await execute("not_a_real_tool", {}, fakeMessage, {});
    expect(result).toBeUndefined();
  });
});
