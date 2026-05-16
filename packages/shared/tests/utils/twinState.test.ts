import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { createTwinState } from "../../src/utils/twinState.js";

const origFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = origFetch;
});

describe("createTwinState — input validation", () => {
  it("throws when getSecret is missing", () => {
    // @ts-expect-error testing missing arg
    expect(() => createTwinState({ getUrl: () => "x" })).toThrow();
  });
  it("throws when getUrl is missing", () => {
    // @ts-expect-error testing missing arg
    expect(() => createTwinState({ getSecret: () => "x" })).toThrow();
  });
});

describe("twinState.getTwinStateCached", () => {
  it("returns error when secret is missing", async () => {
    const ts = createTwinState({ getSecret: () => undefined, getUrl: () => "http://x" });
    const r = await ts.getTwinStateCached({ force: true });
    expect(r.error).toMatch(/not configured/);
  });

  it("returns error when url is missing", async () => {
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => undefined });
    const r = await ts.getTwinStateCached({ force: true });
    expect(r.error).toMatch(/not configured/);
  });

  it("returns error when fetch returns non-ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => "http://x" });
    const r = await ts.getTwinStateCached({ force: true });
    expect(r.error).toBeTruthy();
  });

  it("caches successful responses for 5 minutes", async () => {
    const payload = { bot: "irene", mood_score: 25, energy: 60, preoccupation: null };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    globalThis.fetch = fetchSpy as any;
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => "http://x" });

    const first = await ts.getTwinStateCached({ force: true });
    expect(first.state).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await ts.getTwinStateCached();
    expect(second.state).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("force:true bypasses the cache", async () => {
    const payload = { bot: "irene", mood_score: 0 };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    globalThis.fetch = fetchSpy as any;
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => "http://x" });

    await ts.getTwinStateCached({ force: true });
    await ts.getTwinStateCached({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("logs via injected log on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as any;
    const captured: string[] = [];
    const ts = createTwinState({
      getSecret: () => "s",
      getUrl: () => "http://x",
      log: (m: string) => captured.push(m),
    });
    await ts.getTwinStateCached({ force: true });
    expect(captured.some(m => /Fetch failed/.test(m))).toBe(true);
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
  });

  it("returns empty when message does not mention the twin", async () => {
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => "http://x" });
    const ctx = await ts.buildTwinStateContext("hey whats up");
    expect(ctx).toBe("");
  });

  it("returns context when message mentions the twin by name", async () => {
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => "http://x" });
    const ctx = await ts.buildTwinStateContext("is irene around", { twinName: "irene" });
    expect(ctx).toMatch(/TWIN STATE/);
    expect(ctx).toMatch(/good mood|doing ok/);
    expect(ctx).toMatch(/valorant/);
  });

  it("requires a word-boundary name match (doesnt match substring)", async () => {
    const ts = createTwinState({ getSecret: () => "s", getUrl: () => "http://x" });
    const ctx = await ts.buildTwinStateContext("a serene morning", { twinName: "irene" });
    expect(ctx).toBe("");
  });
});
