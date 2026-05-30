import { describe, expect, it, beforeEach } from "vitest";
import {
  isExplicitGifRequest,
  recordNaturalGif,
  resetGifCadenceForTests,
  shouldAllowNaturalGif,
} from "../../src/ai/gifCadence.js";

describe("gifCadence", () => {
  beforeEach(() => resetGifCadenceForTests());

  it("allows explicit GIF/direct-action requests outside the natural cadence", () => {
    expect(isExplicitGifRequest("send a gif of someone laughing")).toBe(true);
    expect(isExplicitGifRequest("do a dab")).toBe(true);
    expect(isExplicitGifRequest("that disgusts me")).toBe(false);
  });

  it("throttles natural GIFs per scope for roughly 2-3 days", () => {
    expect(shouldAllowNaturalGif("g:c", 1_000).allowed).toBe(true);
    recordNaturalGif("g:c", 1_000);

    const soon = shouldAllowNaturalGif("g:c", 1_000 + 24 * 60 * 60 * 1000);
    expect(soon.allowed).toBe(false);
    expect(soon.retryAfterMs).toBeGreaterThan(0);

    expect(shouldAllowNaturalGif("other:c", 1_000 + 24 * 60 * 60 * 1000).allowed).toBe(true);
    expect(shouldAllowNaturalGif("g:c", 1_000 + 61 * 60 * 60 * 1000).allowed).toBe(true);
  });
});
