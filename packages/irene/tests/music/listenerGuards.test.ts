// ─── voice listener — transcription throttle / budget guards ─────────────────
//
// processAudio transcribes EVERY utterance before the wake-word check, so the
// listener meters transcription itself:
//   1. the per-user cooldown starts at transcription time (isUserOnCooldown /
//      touchUserCooldown), not only after a successful wake reply, and
//   2. a per-guild rolling budget (createSttBudget) caps STT calls per minute
//      plus a session total — env-tunable via VOICE_STT_BUDGET_PER_MIN and
//      VOICE_STT_BUDGET_PER_SESSION.
// The helpers are exported from voice/listener.js purely so this test can
// exercise the real logic without a live voice connection.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel: vi.fn(),
  VoiceConnectionStatus: { Ready: "ready" },
  entersState: vi.fn(),
  EndBehaviorType: { AfterSilence: 1 },
  getVoiceConnection: vi.fn(),
}));
vi.mock("../../music/player.js", () => ({ playTTS: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  isUserOnCooldown,
  touchUserCooldown,
  createSttBudget,
  notifyMemberJoined,
} from "../../voice/listener.js";

afterEach(() => {
  delete process.env.VOICE_STT_BUDGET_PER_MIN;
  delete process.env.VOICE_STT_BUDGET_PER_SESSION;
});

describe("per-user transcription cooldown", () => {
  it("a user with no recorded cooldown is not throttled", () => {
    expect(isUserOnCooldown(new Map(), "u1", 1_000_000)).toBe(false);
  });

  it("throttles inside the window and releases after it", () => {
    const cooldowns = new Map<string, number>();
    touchUserCooldown(cooldowns, "u1", 1_000_000);
    expect(isUserOnCooldown(cooldowns, "u1", 1_000_000 + 2_999, 3_000)).toBe(true);
    expect(isUserOnCooldown(cooldowns, "u1", 1_000_000 + 3_000, 3_000)).toBe(false);
  });

  it("cooldowns are per-user", () => {
    const cooldowns = new Map<string, number>();
    touchUserCooldown(cooldowns, "u1", 1_000_000);
    expect(isUserOnCooldown(cooldowns, "u2", 1_000_001, 3_000)).toBe(false);
  });

  it("prunes entries older than 5 minutes once the map exceeds 20 users", () => {
    const cooldowns = new Map<string, number>();
    const now = 10_000_000;
    for (let i = 0; i < 21; i++) {
      cooldowns.set(`stale-${i}`, now - 6 * 60_000);
    }
    touchUserCooldown(cooldowns, "fresh", now);
    expect(cooldowns.has("fresh")).toBe(true);
    expect(cooldowns.has("stale-0")).toBe(false);
    expect(cooldowns.size).toBe(1);
  });
});

describe("per-guild STT budget", () => {
  it("enforces the rolling per-minute window", () => {
    const budget = createSttBudget({ perMinute: 2, perSession: 100 });
    expect(budget.tryConsume(0).ok).toBe(true);
    expect(budget.tryConsume(1_000).ok).toBe(true);
    const third = budget.tryConsume(2_000);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("minute");
    // The window slides: 60s after the first stamp, capacity frees up.
    expect(budget.tryConsume(60_000).ok).toBe(true);
  });

  it("enforces the session-total cap across minutes", () => {
    const budget = createSttBudget({ perMinute: 100, perSession: 3 });
    expect(budget.tryConsume(0).ok).toBe(true);
    expect(budget.tryConsume(70_000).ok).toBe(true);
    expect(budget.tryConsume(140_000).ok).toBe(true);
    const fourth = budget.tryConsume(210_000);
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe("session");
  });

  it("denied calls do not consume budget", () => {
    const budget = createSttBudget({ perMinute: 1, perSession: 100 });
    expect(budget.tryConsume(0).ok).toBe(true);
    expect(budget.tryConsume(1).ok).toBe(false);
    expect(budget.tryConsume(2).ok).toBe(false);
    // Only ONE stamp is in the window — it expires, capacity returns.
    expect(budget.tryConsume(60_001).ok).toBe(true);
  });

  it("reads VOICE_STT_BUDGET_PER_MIN / VOICE_STT_BUDGET_PER_SESSION from env", () => {
    process.env.VOICE_STT_BUDGET_PER_MIN = "1";
    process.env.VOICE_STT_BUDGET_PER_SESSION = "2";
    const budget = createSttBudget();
    expect(budget.tryConsume(0).ok).toBe(true);
    expect(budget.tryConsume(1).reason).toBe("minute");
    expect(budget.tryConsume(61_000).ok).toBe(true);
    expect(budget.tryConsume(122_000).reason).toBe("session");
  });

  it("falls back to sane defaults when env values are garbage", () => {
    process.env.VOICE_STT_BUDGET_PER_MIN = "not-a-number";
    const budget = createSttBudget();
    // Default is 20/min — 20 consumes pass, the 21st trips the window.
    for (let i = 0; i < 20; i++) {
      expect(budget.tryConsume(i).ok).toBe(true);
    }
    expect(budget.tryConsume(20).reason).toBe("minute");
  });
});

describe("consent notice — notifyMemberJoined", () => {
  it("returns false when no listener session is active for the guild", async () => {
    const member = { id: "u1", user: { bot: false }, guild: { channels: { cache: new Map() } } };
    expect(await notifyMemberJoined("guild-without-session", "vc-1", member)).toBe(false);
  });
});
