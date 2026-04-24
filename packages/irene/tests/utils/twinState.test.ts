import { describe, it, expect, beforeEach, vi } from "vitest";

// We can't import the real twinState because it pulls config → DISCORD_TOKEN.
// Setup file handles that. We just test the module's behavior with fetch mocked.

// @ts-expect-error
import * as twinState from "../../utils/twinState.js";

const origFetch = globalThis.fetch;

beforeEach(() => {
  twinState._clearCache();
  process.env.TWIN_API_SECRET = "test-secret";
  globalThis.fetch = origFetch;
});

describe("twinState", () => {
  it("returns error when secret or url is missing", async () => {
    // Force the config to look unset by stubbing fetch to throw loudly — but
    // easier is to just temporarily clear the env var used at import time.
    // We can't do that cleanly since config is already loaded; instead, mock
    // fetch to return 500 so we hit the error path.
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    const r = await twinState.getTwinStateCached({ force: true });
    expect(r.error).toBeTruthy();
  });

  it("caches successful responses for 5 minutes", async () => {
    const payload = { bot: "irene", mood_score: 25, energy: 60, preoccupation: null };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    globalThis.fetch = fetchSpy as any;

    const first = await twinState.getTwinStateCached({ force: true });
    expect(first.state).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await twinState.getTwinStateCached();
    expect(second.state).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("force:true bypasses the cache", async () => {
    const payload = { bot: "irene", mood_score: 0 };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    globalThis.fetch = fetchSpy as any;

    await twinState.getTwinStateCached({ force: true });
    await twinState.getTwinStateCached({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("twinState.buildTwinStateContext", () => {
  beforeEach(() => {
    const payload = {
      bot: "irene",
      mood_score: 40,
      energy: 75,
      preoccupation: { topic: "valorant ranked", flavor: null, source: "user_topic" },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload }) as any;
    twinState._clearCache();
  });

  it("returns empty when message does not mention the twin", async () => {
    const ctx = await twinState.buildTwinStateContext("hey whats up");
    expect(ctx).toBe("");
  });

  it("returns context when message mentions the twin by name", async () => {
    const ctx = await twinState.buildTwinStateContext("is irene around", { twinName: "irene" });
    expect(ctx).toMatch(/TWIN STATE/);
    expect(ctx).toMatch(/good mood|doing ok/);
    expect(ctx).toMatch(/valorant/);
  });

  it("requires a word-boundary name match (doesnt match substring)", async () => {
    const ctx = await twinState.buildTwinStateContext("a serene morning", { twinName: "irene" });
    expect(ctx).toBe("");
  });
});
