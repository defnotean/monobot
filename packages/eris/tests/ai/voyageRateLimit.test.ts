// Voyage rate-limiter split regression — a single shared _voyageLastCall with a
// 5s gap gated BOTH generateEmbedding (store) and generateQueryEmbedding (search),
// so a per-message store and the per-message search collided: whichever ran first
// locked the other out for 5s and recall silently degraded to keyword-only.
// Store and search now have independent 2s trackers. This suite proves both can
// proceed within the same short window.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../config.js", () => ({
  default: { voyageApiKey: "test-voyage-key", botName: "test-eris" },
}));

// @ts-expect-error - importing JS module without types
import * as semantic from "../../ai/semantic.js";

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

// The rate-limiter trackers are module-level state with no reset hook, so each
// test must start the clock well past the 2s gap of the previous test's last
// call. Bump the system time forward per test (1 minute apart, off a fixed base)
// so both trackers always read as "stale enough to proceed" at the start of
// every test.
const _CLOCK_BASE = new Date("2026-05-28T12:00:00Z").getTime();
let _clockMin = 0;

beforeEach(() => {
  vi.useFakeTimers();
  _clockMin += 1;
  vi.setSystemTime(new Date(_CLOCK_BASE + _clockMin * 60_000));
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  }));
  globalThis.fetch = fetchSpy as never;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("Voyage store/search trackers are independent", () => {
  it("a store and a search embedding both proceed back-to-back (no mutual lock)", async () => {
    const stored = await semantic.generateEmbedding("a thing happened in the channel today");
    const queried = await semantic.generateQueryEmbedding("what happened in the channel");

    // Both succeeded — search was NOT blocked by the immediately-preceding store.
    expect(stored).toEqual([0.1, 0.2, 0.3]);
    expect(queried).toEqual([0.1, 0.2, 0.3]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("each tracker still self-throttles within its own 2s window", async () => {
    // Two stores back-to-back: the second is rate-limited by the store tracker.
    const first = await semantic.generateEmbedding("first store");
    const second = await semantic.generateEmbedding("second store");
    expect(first).toEqual([0.1, 0.2, 0.3]);
    expect(second).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // After the 2s gap elapses the store tracker frees up again.
    vi.advanceTimersByTime(2001);
    const third = await semantic.generateEmbedding("third store after gap");
    expect(third).toEqual([0.1, 0.2, 0.3]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("two searches back-to-back self-throttle on the search tracker independently of store", async () => {
    // Prime the store tracker — must NOT affect the search tracker.
    await semantic.generateEmbedding("store call");
    const s1 = await semantic.generateQueryEmbedding("search one");
    const s2 = await semantic.generateQueryEmbedding("search two");
    expect(s1).toEqual([0.1, 0.2, 0.3]); // search not blocked by the store
    expect(s2).toBeNull();               // but second search blocked by first
  });
});
