import { describe, expect, it } from "vitest";

describe("eris humanity exports", () => {
  it("preserves the public export surface without judge helpers", async () => {
    const humanity = await import("../../ai/humanity.js");

    expect(Object.keys(humanity).sort()).toEqual([
      "buildHumanityContext",
      "buildTwinContext",
      "deserialize",
      "detectMoment",
      "generateThought",
      "periodicUpdate",
      "recordInsideJoke",
      "recordMoment",
      "serialize",
      "trackHumanInteraction",
    ].sort());
  });
});
