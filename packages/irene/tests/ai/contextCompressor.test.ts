import { describe, it, expect } from "vitest";
import { compressHistory } from "../../ai/contextCompressor.js";

describe("compressHistory — first-turn preservation", () => {
  it("never removes history[0] under tight budget", () => {
    const history: any[] = [];
    history.push({ role: "user", content: "ORIGINAL_TASK: please set up the server" });
    // 30 follow-up turns of fluff
    for (let i = 0; i < 30; i++) {
      history.push({ role: "assistant", content: "x".repeat(500) });
      history.push({ role: "user", content: "y".repeat(500) });
    }
    const result = compressHistory(history, 1000);
    // The first user turn must still be present after compression
    expect(result[0].role).toBe("user");
    expect(typeof result[0].content === "string" && result[0].content.includes("ORIGINAL_TASK")).toBe(true);
  });

  it("still drops middle entries to fit budget", () => {
    const history: any[] = [];
    history.push({ role: "user", content: "first" });
    for (let i = 0; i < 50; i++) {
      history.push({ role: "assistant", content: "filler-" + "x".repeat(200) });
      history.push({ role: "user", content: "more-" + "y".repeat(200) });
    }
    const beforeLen = history.length;
    const result = compressHistory(history, 500);
    // history was mutated in place, length should have dropped
    expect(result.length).toBeLessThan(beforeLen);
    // and history[0] is still the original first turn
    expect(result[0].content).toContain("first");
  });
});
