import { describe, expect, it } from "vitest";

// @ts-expect-error JS module without types
import { appendModelReplyIfMissing } from "../../../events/messageCreate/analytics.js";

describe("messageCreate analytics history persistence", () => {
  it("does not append the same assistant reply twice", () => {
    const history: any[] = [{ role: "model", parts: [{ text: "done" }] }];

    expect(appendModelReplyIfMissing(history, "done")).toBe(false);
    expect(history).toHaveLength(1);
  });

  it("appends a new assistant reply and caps stored text", () => {
    const history: any[] = [];

    expect(appendModelReplyIfMissing(history, "x".repeat(2500))).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "model" });
    expect(history[0].parts[0].text).toHaveLength(1900);
  });
});
