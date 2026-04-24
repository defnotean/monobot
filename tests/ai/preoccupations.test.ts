import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import {
  pickPreoccupation,
  buildPreoccupationContext,
  _setForTest,
  _reset,
} from "../../ai/preoccupations.js";

beforeEach(() => _reset());

describe("pickPreoccupation", () => {
  it("falls back when no chat signal is present", () => {
    const p = pickPreoccupation({});
    expect(p.topic).toBeTruthy();
    expect(p.source).toBe("fallback");
    expect(p.expiresAt).toBeGreaterThan(p.startedAt);
  });

  it("prefers user_topic when a strong signal exists", () => {
    const personality = {
      user_styles: {
        userA: { topics: [{ name: "valorant", count: 30 }] },
        userB: { topics: [{ name: "valorant", count: 20 }] },
      },
    };
    // Because selection is probabilistic, sample many picks.
    let sawUserTopic = false;
    for (let i = 0; i < 100; i++) {
      const p = pickPreoccupation(personality);
      if (p.source === "user_topic" && p.topic === "valorant") sawUserTopic = true;
    }
    expect(sawUserTopic).toBe(true);
  });

  it("ignores user_topic signal below the minimum tally threshold", () => {
    const personality = {
      user_styles: { u: { topics: [{ name: "tiny", count: 1 }] } },
    };
    for (let i = 0; i < 20; i++) {
      const p = pickPreoccupation(personality);
      expect(p.topic).not.toBe("tiny");
    }
  });

  it("produces expiresAt within ROTATION_MIN_DAYS..ROTATION_MAX_DAYS window", () => {
    const p = pickPreoccupation({});
    const days = (p.expiresAt - p.startedAt) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThanOrEqual(3);
    expect(days).toBeLessThanOrEqual(8);
  });
});

describe("buildPreoccupationContext", () => {
  it("returns empty string when no preoccupation is set", () => {
    expect(buildPreoccupationContext({ chance: 1 })).toBe("");
  });

  it("returns a PREOCCUPATION fragment when chance=1 and one is loaded", () => {
    _setForTest({ topic: "anime", flavor: "been watching", source: "fallback", startedAt: 0, expiresAt: Date.now() + 1e9, lastInjected: 0 });
    const ctx = buildPreoccupationContext({ chance: 1 });
    expect(ctx).toContain("[PREOCCUPATION:");
    expect(ctx).toContain("anime");
  });

  it("respects chance=0 and never injects", () => {
    _setForTest({ topic: "x", flavor: "y", source: "fallback", startedAt: 0, expiresAt: Date.now() + 1e9, lastInjected: 0 });
    for (let i = 0; i < 50; i++) {
      expect(buildPreoccupationContext({ chance: 0 })).toBe("");
    }
  });
});
