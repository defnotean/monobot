import { describe, it, expect } from "vitest";
import { compressHistory } from "../../ai/contextCompressor.js";

describe("compressHistory — first-turn preservation (Gemini format)", () => {
  it("never removes history[0] under tight budget", () => {
    const history: any[] = [];
    history.push({ role: "user", parts: [{ text: "ORIGINAL_TASK: please set up the server" }] });
    for (let i = 0; i < 30; i++) {
      history.push({ role: "model", parts: [{ text: "x".repeat(500) }] });
      history.push({ role: "user", parts: [{ text: "y".repeat(500) }] });
    }
    const result = compressHistory(history, 1000);
    expect(result[0].role).toBe("user");
    expect(result[0].parts[0].text.includes("ORIGINAL_TASK")).toBe(true);
  });

  it("still drops middle entries to fit budget", () => {
    const history: any[] = [];
    history.push({ role: "user", parts: [{ text: "first" }] });
    for (let i = 0; i < 50; i++) {
      history.push({ role: "model", parts: [{ text: "filler-" + "x".repeat(200) }] });
      history.push({ role: "user", parts: [{ text: "more-" + "y".repeat(200) }] });
    }
    const beforeLen = history.length;
    const result = compressHistory(history, 500);
    expect(result.length).toBeLessThan(beforeLen);
    expect(result[0].parts[0].text).toContain("first");
  });
});
