import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────
// ready.js pulls in a huge graph (poker, stocks, lottery, longmemory,
// humanity, randomEvents, personality, etc.) almost all of which is lazy
// `await import()`. The synchronous imports at the top of ready.js are the
// only ones we need to stub up front; the dynamic imports never run because
// we never let the setInterval callbacks fire (fake timers).

// State controllable per-test
const dbState = {
  creatorAffinity: 0,
  whitelist: new Set<string>(),
  addToWhitelistCalls: [] as Array<{ guildId: string; info: Record<string, unknown> }>,
  leftGuilds: [] as string[],
  updateRelationshipCalls: [] as Array<{ userId: string; delta: number }>,
  supabase: null as null | object,
};

vi.mock("../../database.js", () => ({
  getRelationship: (userId: string) => ({
    affinity_score: dbState.creatorAffinity,
    interactions_count: 0,
    userId,
  }),
  updateRelationship: (userId: string, delta: number) => {
    dbState.updateRelationshipCalls.push({ userId, delta });
    dbState.creatorAffinity = Math.max(-100, Math.min(100, dbState.creatorAffinity + delta));
  },
  isWhitelisted: async (guildId: string) => dbState.whitelist.has(guildId),
  addToWhitelist: async (guildId: string, info: Record<string, unknown>) => {
    dbState.addToWhitelistCalls.push({ guildId, info });
    dbState.whitelist.add(guildId);
    return true;
  },
  getSupabase: () => dbState.supabase,
  getGuildSettings: () => ({}),
  getMood: () => ({ mood_score: 0, energy: 50 }),
  shiftMood: vi.fn(),
  saveDream: vi.fn(),
  getPendingReminders: async () => [],
  markReminderDone: vi.fn(),
  markRemindersDoneBatch: vi.fn(),
  getOverdueLoans: async () => [],
  getUnpostedConfessions: () => [],
  getConfessionNumber: () => 0,
  getUserReminders: async () => [],
  cleanupExpiredDuels: vi.fn(),
  cleanupExpiredGames: () => [],
  closeExpiredAuctions: async () => [],
  updateBalance: vi.fn(),
  closeLoan: vi.fn(),
  unlockAchievement: vi.fn(),
  collectTerritoryIncome: vi.fn(),
  getTerritories: async () => [],
  getFeatureConfig: () => null,
}));

// Restore-bump / bumpathon watcher / mvp scheduler / game watcher are all
// fire-and-forget on startup — stub them so they don't reach Supabase.
vi.mock("../../ai/bumpReminder.js", () => ({
  restoreBumpTimers: vi.fn(),
}));
vi.mock("../../ai/bumpCelebrations.js", () => ({
  startBumpathonWatcher: vi.fn(),
  startWeeklyMvpScheduler: vi.fn(),
}));
vi.mock("../../ai/gameWatcher.js", () => ({
  startGameWatcher: vi.fn(),
}));

// utils/discord.js is imported for getFeatureChannel but only used inside a
// setInterval body, so we just need the symbol to exist.
vi.mock("../../utils/discord.js", () => ({
  getFeatureChannel: () => ({ channel: null, pingPrefix: "" }),
}));

// GoogleGenAI is imported at the top of ready.js but only constructed when
// a heartbeat tick fires — fake timers prevent that, so a no-op class is fine.
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({ candidates: [] }),
    };
  },
}));

// Config — we only touch ownerId from the synchronous ready path.
vi.mock("../../config.js", () => ({
  default: {
    ownerId: "111111111111111111",
    aiProvider: "gemini",
    geminiKeys: ["dummy"],
    geminiFastModel: "test-model",
    dreamChannelId: null,
    briefingChannelId: null,
  },
}));

// Logger — capture lines for assertion without spamming stdout.
const loggedLines: string[] = [];
vi.mock("../../utils/logger.js", () => ({
  log: (msg: string) => { loggedLines.push(String(msg)); },
}));

// @ts-expect-error - importing JS module without types
import ready from "../../events/ready.js";

// ─── Fake Discord client ──────────────────────────────────────────────────
function makeGuild({
  id,
  name,
  ownerId,
  ownerInCache = false,
  memberFetchSucceeds = false,
}: {
  id: string;
  name: string;
  ownerId: string;
  ownerInCache?: boolean;
  memberFetchSucceeds?: boolean;
}) {
  const leaveCalls: string[] = [];
  const guild: any = {
    id,
    name,
    ownerId,
    memberCount: 5,
    iconURL: () => null,
    leave: vi.fn(async () => { leaveCalls.push(id); }),
    members: {
      cache: new Map<string, unknown>(),
      fetch: vi.fn(async () => (memberFetchSucceeds ? { id: "owner" } : null)),
    },
  };
  if (ownerInCache) guild.members.cache.set("111111111111111111", { id: "owner" });
  return { guild, leaveCalls };
}

function makeClient(guilds: any[]) {
  return {
    user: { tag: "TestEris#0001" },
    guilds: { cache: new Map(guilds.map(g => [g.id, g])) },
    users: {
      fetch: vi.fn(async () => ({
        createDM: async () => ({ id: "dm-channel-id" }),
      })),
    },
    channels: { fetch: vi.fn(async () => null) },
  } as any;
}

// ─── Fixture reset ────────────────────────────────────────────────────────
beforeEach(() => {
  // Freeze time and capture setInterval/setTimeout calls so background
  // timers don't actually fire during the test.
  vi.useFakeTimers();
  loggedLines.length = 0;
  dbState.creatorAffinity = 0;
  dbState.whitelist.clear();
  dbState.addToWhitelistCalls.length = 0;
  dbState.leftGuilds.length = 0;
  dbState.updateRelationshipCalls.length = 0;
  dbState.supabase = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────
describe("events/ready", () => {
  it("logs the bot-online line with the user tag and guild count", async () => {
    const { guild } = makeGuild({ id: "g1", name: "Owned", ownerId: "111111111111111111" });
    const client = makeClient([guild]);

    await ready(client);

    const onlineLine = loggedLines.find(l => l.startsWith("[BOT]") && l.includes("online"));
    expect(onlineLine).toBeDefined();
    expect(onlineLine).toContain("TestEris#0001");
    expect(onlineLine).toContain("guilds: 1");
  });

  it("bumps creator affinity to 100 when it starts below the cap", async () => {
    dbState.creatorAffinity = 25;
    const { guild } = makeGuild({ id: "g1", name: "Owned", ownerId: "111111111111111111" });
    const client = makeClient([guild]);

    await ready(client);

    expect(dbState.updateRelationshipCalls).toHaveLength(1);
    expect(dbState.updateRelationshipCalls[0]).toEqual({ userId: "111111111111111111", delta: 75 });
    expect(dbState.creatorAffinity).toBe(100);
  });

  it("leaves the creator alone when affinity is already pinned at 100", async () => {
    dbState.creatorAffinity = 100;
    const { guild } = makeGuild({ id: "g1", name: "Owned", ownerId: "111111111111111111" });
    const client = makeClient([guild]);

    await ready(client);

    expect(dbState.updateRelationshipCalls).toHaveLength(0);
  });

  it("leaves unauthorized guilds (not owned, not whitelisted, owner not a member)", async () => {
    const { guild, leaveCalls } = makeGuild({
      id: "g-unauth",
      name: "Stranger",
      ownerId: "999999999999999999",
      ownerInCache: false,
      memberFetchSucceeds: false,
    });
    const client = makeClient([guild]);

    await ready(client);

    expect(leaveCalls).toEqual(["g-unauth"]);
    // Unauthorized guilds are NOT added to the whitelist.
    expect(dbState.addToWhitelistCalls.find(c => c.guildId === "g-unauth")).toBeUndefined();
    const gatekeepLine = loggedLines.find(l => l.includes("[GATEKEEP]") && l.includes("Leaving"));
    expect(gatekeepLine).toBeDefined();
  });

  it("auto-tracks an owner-present guild into the whitelist on startup", async () => {
    const { guild, leaveCalls } = makeGuild({
      id: "g-ownerin",
      name: "Boss Hangout",
      ownerId: "999999999999999999",
      ownerInCache: true, // boss is a member, even though not the server owner
    });
    const client = makeClient([guild]);

    await ready(client);

    expect(leaveCalls).toEqual([]); // never left
    expect(dbState.addToWhitelistCalls).toHaveLength(1);
    expect(dbState.addToWhitelistCalls[0].guildId).toBe("g-ownerin");
    expect(dbState.addToWhitelistCalls[0].info.invited_by).toBe("auto-tracked-on-startup");
  });

  it("registers background interval timers (sched, mood, briefing, etc.)", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { guild } = makeGuild({ id: "g1", name: "Owned", ownerId: "111111111111111111" });
    const client = makeClient([guild]);

    await ready(client);

    // ready.js wires up well over a dozen long-running interval handlers
    // (stocks, lottery, reminders, mood, dream, heartbeat, briefing,
    // confessions, duels, games, loans, challenges, territories,
    // auctions, humanity-save, personality, map-cleanup, minions, events).
    // Don't pin the exact count — the codebase will grow — but require a
    // healthy lower bound so nobody can accidentally delete the lot.
    expect(setIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(15);
  });

  it("boots without throwing when Supabase is absent", async () => {
    // Default fixture leaves supabase=null. Covers the consciousness load,
    // humanity load, curses restore, and confession poster paths that all
    // bail out cleanly when getSupabase() returns null.
    dbState.supabase = null;
    const { guild } = makeGuild({ id: "g1", name: "Owned", ownerId: "111111111111111111" });
    const client = makeClient([guild]);

    await expect(ready(client)).resolves.toBeUndefined();
    // And the bot-online line should still have made it out.
    expect(loggedLines.some(l => l.startsWith("[BOT]") && l.includes("online"))).toBe(true);
  });

  it("logs a SCHED summary line once background tasks are wired up", async () => {
    const { guild } = makeGuild({ id: "g1", name: "Owned", ownerId: "111111111111111111" });
    const client = makeClient([guild]);

    await ready(client);

    const schedLine = loggedLines.find(l => l.startsWith("[SCHED]") && l.includes("Background tasks started"));
    expect(schedLine).toBeDefined();
  });
});
