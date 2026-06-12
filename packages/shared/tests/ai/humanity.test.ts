import { describe, expect, it, vi } from "vitest";
// @ts-expect-error - importing JS module without types
import { createHumanity } from "../../src/ai/humanity.js";

function makeHumanity(options: Record<string, unknown> = {}) {
  let now = Number(options.nowValue ?? 0);
  const module = createHumanity({
    logger: vi.fn(),
    random: () => 0.5,
    now: () => now,
    ...options,
  });
  return {
    module,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("createHumanity", () => {
  it("supports Eris hourly grudge decay and UTC streak keys", () => {
    const { module, setNow } = makeHumanity({
      grudgeDecayMode: "hourly",
      streakDateStrategy: "utc-day",
    });

    module.trackHumanInteraction("u1", "alice", "that was mean", -1);
    setNow(30 * 60 * 1000);
    module.trackHumanInteraction("u1", "alice", "neutral check-in", 0);
    expect(module.serialize().relationships.u1.grudge).toBe(10);

    setNow(2 * 60 * 60 * 1000);
    module.trackHumanInteraction("u1", "alice", "neutral check-in", 0);

    const rel = module.serialize().relationships.u1;
    expect(rel.grudge).toBe(8);
    expect(rel._lastDayUtc).toBe(0);
    expect(rel._lastDay).toBeUndefined();
  });

  it("supports Irene interaction grudge decay and local date streak keys", () => {
    const { module } = makeHumanity({
      grudgeDecayMode: "interaction",
      streakDateStrategy: "local-date",
    });

    module.trackHumanInteraction("u1", "alice", "that was mean", -1);
    module.trackHumanInteraction("u1", "alice", "neutral check-in", 0);

    const rel = module.serialize().relationships.u1;
    expect(rel.grudge).toBe(8);
    expect(rel._lastDay).toBeTypeOf("string");
    expect(rel._lastDayUtc).toBeUndefined();
  });

  it("exposes the humanity judge API only when requested", () => {
    const { module: withoutJudge } = makeHumanity({ includeJudgeApi: false });
    expect(withoutJudge.shouldRunHumanityJudge).toBeUndefined();
    expect(withoutJudge.recordHumanityJudgeResult).toBeUndefined();

    const { module, setNow } = makeHumanity({ includeJudgeApi: true });

    expect(module.shouldRunHumanityJudge("c1")).toEqual({ allow: true, cachedResult: null });
    module.recordHumanityJudgeResult("c1", { mood: "soft" });
    setNow(10_000);
    expect(module.shouldRunHumanityJudge("c1")).toEqual({
      allow: false,
      cachedResult: { mood: "soft" },
    });
    setNow(31_000);
    expect(module.shouldRunHumanityJudge("c1")).toEqual({
      allow: true,
      cachedResult: { mood: "soft" },
    });
  });
});
