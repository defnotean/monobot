import { describe, it, expect, beforeEach } from "vitest";

// @ts-expect-error — JS module, no types
import {
  recordMessage,
  getEvidence,
  formatEvidence,
  clearEvidence,
  evidenceBufferSize,
  __internals,
} from "../../utils/messageEvidence.js";

// Minimal message shape that matches what messageCreate.js actually has
function makeMsg(overrides: any = {}) {
  return {
    id: overrides.id ?? `m${Math.random().toString(36).slice(2, 8)}`,
    guildId: overrides.guildId ?? "g1",
    author: overrides.author ?? { id: "u1", bot: false },
    channelId: overrides.channelId ?? "c1",
    channel: overrides.channel ?? { name: "general" },
    content: overrides.content ?? "hello world",
    attachments: overrides.attachments ?? new Map(),
    stickers: overrides.stickers ?? new Map(),
    createdTimestamp: overrides.createdTimestamp ?? 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  // Clear the internal buckets map between tests.
  __internals._buckets._map.clear();
  __internals._buckets._groups?.clear?.();
});

describe("messageEvidence.recordMessage", () => {
  it("records a guild message", () => {
    recordMessage(makeMsg({ content: "first" }));
    const ev = getEvidence("g1", "u1");
    expect(ev).toHaveLength(1);
    expect(ev[0].content).toBe("first");
  });

  it("ignores DMs (no guildId)", () => {
    recordMessage(makeMsg({ guildId: null }));
    expect(getEvidence("g1", "u1")).toEqual([]);
  });

  it("ignores bot messages", () => {
    recordMessage(makeMsg({ author: { id: "u1", bot: true } }));
    expect(getEvidence("g1", "u1")).toEqual([]);
  });

  it("ignores messages with no author (edge case)", () => {
    recordMessage(makeMsg({ author: null }));
    expect(getEvidence("g1", "u1")).toEqual([]);
  });

  it("keeps only the most recent MAX_MESSAGES_PER_USER", () => {
    const MAX = __internals.MAX_MESSAGES_PER_USER;
    for (let i = 0; i < MAX + 5; i++) {
      recordMessage(makeMsg({ content: `msg ${i}`, id: `m${i}` }));
    }
    const ev = getEvidence("g1", "u1");
    expect(ev).toHaveLength(MAX);
    // Oldest 5 got evicted — first remaining should be msg 5
    expect(ev[0].content).toBe(`msg 5`);
    expect(ev[MAX - 1].content).toBe(`msg ${MAX + 4}`);
  });

  it("caps per-message content at 500 chars", () => {
    const huge = "x".repeat(2000);
    recordMessage(makeMsg({ content: huge }));
    const ev = getEvidence("g1", "u1");
    expect(ev[0].content).toHaveLength(500);
  });

  it("isolates per-guild buffers", () => {
    recordMessage(makeMsg({ guildId: "g1", content: "guild one" }));
    recordMessage(makeMsg({ guildId: "g2", content: "guild two" }));
    expect(getEvidence("g1", "u1")).toHaveLength(1);
    expect(getEvidence("g1", "u1")[0].content).toBe("guild one");
    expect(getEvidence("g2", "u1")).toHaveLength(1);
    expect(getEvidence("g2", "u1")[0].content).toBe("guild two");
  });

  it("isolates per-user buffers within a guild", () => {
    recordMessage(makeMsg({ author: { id: "u1", bot: false }, content: "alice" }));
    recordMessage(makeMsg({ author: { id: "u2", bot: false }, content: "bob" }));
    expect(getEvidence("g1", "u1")[0].content).toBe("alice");
    expect(getEvidence("g1", "u2")[0].content).toBe("bob");
  });

  it("captures attachment and sticker counts", () => {
    const atts = new Map([["a1", {}], ["a2", {}]]);
    const stks = new Map([["s1", {}]]);
    recordMessage(makeMsg({ attachments: atts, stickers: stks, content: "with stuff" }));
    const ev = getEvidence("g1", "u1");
    expect(ev[0].attachmentCount).toBe(2);
    expect(ev[0].stickerCount).toBe(1);
  });
});

describe("messageEvidence.getEvidence", () => {
  it("returns [] when nothing captured", () => {
    expect(getEvidence("never", "seen")).toEqual([]);
  });

  it("returns [] for missing args", () => {
    expect(getEvidence(null as any, "u1")).toEqual([]);
    expect(getEvidence("g1", null as any)).toEqual([]);
    expect(getEvidence(undefined as any, undefined as any)).toEqual([]);
  });
});

describe("messageEvidence.formatEvidence", () => {
  it("returns empty string on empty array", () => {
    expect(formatEvidence([])).toBe("");
  });

  it("returns empty string on non-array", () => {
    expect(formatEvidence(null as any)).toBe("");
    expect(formatEvidence(undefined as any)).toBe("");
  });

  it("formats timestamp as Discord relative token", () => {
    const ts = 1_700_000_000_000;
    recordMessage(makeMsg({ content: "hi", createdTimestamp: ts }));
    const out = formatEvidence(getEvidence("g1", "u1"));
    expect(out).toContain(`<t:${Math.floor(ts / 1000)}:R>`);
    expect(out).toContain("#general");
    expect(out).toContain("hi");
  });

  it("marks messages with attachments and stickers", () => {
    recordMessage(makeMsg({
      content: "",
      attachments: new Map([["a", {}]]),
      stickers: new Map([["s", {}]]),
    }));
    const out = formatEvidence(getEvidence("g1", "u1"));
    expect(out).toContain("📎 ×1");
    expect(out).toContain("🧸 ×1");
  });

  it("substitutes '(no text)' for empty content", () => {
    recordMessage(makeMsg({ content: "" }));
    const out = formatEvidence(getEvidence("g1", "u1"));
    expect(out).toContain("(no text)");
  });
});

describe("messageEvidence.clearEvidence + evidenceBufferSize", () => {
  it("clearEvidence drops one user's bucket", () => {
    recordMessage(makeMsg({ author: { id: "u1", bot: false } }));
    recordMessage(makeMsg({ author: { id: "u2", bot: false } }));
    expect(evidenceBufferSize()).toBe(2);
    clearEvidence("g1", "u1");
    expect(evidenceBufferSize()).toBe(1);
    expect(getEvidence("g1", "u1")).toEqual([]);
    expect(getEvidence("g1", "u2")).toHaveLength(1);
  });

  it("evidenceBufferSize reflects active buckets", () => {
    expect(evidenceBufferSize()).toBe(0);
    recordMessage(makeMsg({ author: { id: "u1", bot: false } }));
    expect(evidenceBufferSize()).toBe(1);
    recordMessage(makeMsg({ author: { id: "u1", bot: false } }));
    // Same user — still 1 bucket
    expect(evidenceBufferSize()).toBe(1);
    recordMessage(makeMsg({ author: { id: "u2", bot: false } }));
    expect(evidenceBufferSize()).toBe(2);
  });
});
