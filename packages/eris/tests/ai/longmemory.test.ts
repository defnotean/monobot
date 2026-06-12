import { describe, expect, test } from "vitest";

import * as longmemory from "../../ai/longmemory.js";

const PUBLIC_EXPORTS = [
  "addThought",
  "analyzeExchange",
  "buildLongTermContext",
  "extractThoughts",
  "flush",
  "generateInnerThought",
  "getChannelEpisodes",
  "getEpisodes",
  "getMonologue",
  "getMoodNarrative",
  "inferMoodNarrative",
  "loadLongMemory",
  "recordEpisode",
  "updateMoodNarrative",
];

describe("longmemory public exports", () => {
  test("preserves Eris longmemory surface", () => {
    expect(Object.keys(longmemory).sort()).toEqual(PUBLIC_EXPORTS);
  });
});
