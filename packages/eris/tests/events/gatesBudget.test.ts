import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Integration coverage for the OPT-IN daily AI-call ceiling wired into the
// Eris gating gauntlet (runGates). Proves:
//   (a) caps unset → pure pass-through, no behavior change (gate proceeds);
//   (b) with a per-user cap of N, the N+1th AI-eligible message is gated;
//   (c) the counter resets at the UTC day rollover (injected clock);
// The real aiBudget module runs (not mocked) so the wiring itself is exercised.

const { OWNER_ID, USER_ID, BOT_ID, TWIN_ID } = vi.hoisted(() => ({
  OWNER_ID: "999999999999999999",
  USER_ID: "222222222222222222",
  BOT_ID: "111111111111111111",
  TWIN_ID: "333333333333333333",
}));

vi.mock("../../config.js", () => ({
  default: {
    ownerId: OWNER_ID,
    twinBotId: TWIN_ID,
    aiCooldownMs: 1500,
    voyageApiKey: null,
  },
}));

vi.mock("../../database.js", () => ({
  getSupabase: () => null,
  getGuildSettings: () => null,
  getDirectives: () => [],
  getServerPersona: () => null,
}));

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../utils/cooldown.js", () => ({ checkCooldown: () => ({ onCooldown: false }) }));
vi.mock("../../ai/bumpReminder.js", () => ({
  detectBumpService: () => null,
  handleBumpConfirm: vi.fn(),
  SERVICES: {},
}));
vi.mock("../../ai/providers/index.js", () => ({ isRateLimited: async () => false }));
vi.mock("../../ai/humanity.js", () => ({ periodicUpdate: vi.fn() }));
vi.mock("./sleepState.js", () => ({ isSleeping: () => false, wakeSleep: vi.fn() }));
vi.mock("./spamTracker.js", () => ({
  trackMessage: () => ({ count: 1 }),
  addWarning: () => 1,
  jaccardSim: () => 0,
}));
vi.mock("./constants.js", () => ({ EXPLOIT_PATTERNS: [], AWAIT_REPLY_MS: 90_000 }));
// Benign content so the firewall (real) returns safe and the gate proceeds.
vi.mock("../../ai/firewall.js", () => ({ checkInjection: async () => ({ safe: true }) }));

// @ts-expect-error - importing JS module without types
import { runGates } from "../../events/messageCreate/gates.js";
// @ts-expect-error - importing JS module without types
import * as budget from "../../utils/aiBudget.js";

interface MessageLike {
  id: string;
  content: string;
  partial?: boolean;
  author: { id: string; bot?: boolean; username?: string };
  guild?: unknown;
  channel: { id: string; name?: string };
  client: { user: { id: string; username: string } };
  mentions: { has: () => boolean };
  reply: (...args: any[]) => Promise<unknown>;
}

let replySpy: ReturnType<typeof vi.fn>;

function makeDM(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: "msg-" + Math.random().toString(36).slice(2),
    content: "hey what's up",
    partial: false,
    author: { id: USER_ID, bot: false, username: "chatty" },
    guild: undefined, // DM — skips guild-only gates, isolates the budget gate
    channel: { id: "dm-channel", name: "dm" },
    client: { user: { id: BOT_ID, username: "eris" } },
    mentions: { has: () => false },
    reply: replySpy,
    ...overrides,
  };
}

beforeEach(() => {
  replySpy = vi.fn(async () => {});
  delete process.env.AI_DAILY_USER_CAP;
  delete process.env.AI_DAILY_GUILD_CAP;
  budget._reset();
});

afterEach(() => {
  delete process.env.AI_DAILY_USER_CAP;
  delete process.env.AI_DAILY_GUILD_CAP;
  budget._reset();
});

describe("runGates — AI budget gate", () => {
  it("(a) caps unset → pure pass-through (proceeds, no reply)", async () => {
    const g1 = await runGates(makeDM());
    expect(g1.stop).toBe(false);
    const g2 = await runGates(makeDM());
    expect(g2.stop).toBe(false);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("(b) per-user cap of 2 → the 3rd AI-eligible message is gated + one notice", async () => {
    process.env.AI_DAILY_USER_CAP = "2";
    budget._setClock(() => 0);
    budget._reset();
    process.env.AI_DAILY_USER_CAP = "2";

    expect((await runGates(makeDM())).stop).toBe(false); // 1
    expect((await runGates(makeDM())).stop).toBe(false); // 2
    expect(await runGates(makeDM())).toEqual({ stop: true }); // 3 — gated
    expect(await runGates(makeDM())).toEqual({ stop: true }); // 4 — still gated

    // One short notice for this user this UTC day, not one per dropped message.
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0][0]).toMatch(/daily chat limit/i);
  });

  it("(b') the owner is exempt from the cap", async () => {
    process.env.AI_DAILY_USER_CAP = "1";
    budget._setClock(() => 0);
    budget._reset();
    process.env.AI_DAILY_USER_CAP = "1";

    const owner = () => makeDM({ author: { id: OWNER_ID, bot: false, username: "boss" } });
    for (let i = 0; i < 5; i++) expect((await runGates(owner())).stop).toBe(false);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("(c) the counter resets at the UTC day rollover", async () => {
    process.env.AI_DAILY_USER_CAP = "1";
    let nowMs = 0;
    budget._setClock(() => nowMs);
    budget._reset();
    budget._setClock(() => nowMs);
    process.env.AI_DAILY_USER_CAP = "1";

    expect((await runGates(makeDM())).stop).toBe(false);   // 1 — proceeds
    expect(await runGates(makeDM())).toEqual({ stop: true }); // 2 — gated same day

    nowMs = 86_400_000; // advance one full UTC day
    expect((await runGates(makeDM())).stop).toBe(false);   // fresh day — proceeds again
  });
});
