import { describe, expect, it } from "vitest";

describe("irene humanity exports", () => {
  it("preserves the public export surface including judge helpers", async () => {
    const humanity = await import("../../ai/humanity.js");

    expect(Object.keys(humanity).sort()).toEqual([
      "buildHumanityContext",
      "buildTwinContext",
      "deserialize",
      "detectMoment",
      "generateThought",
      "periodicUpdate",
      "recordHumanityJudgeResult",
      "recordInsideJoke",
      "recordMoment",
      "serialize",
      "shouldRunHumanityJudge",
      "trackHumanInteraction",
    ].sort());
  });
});
