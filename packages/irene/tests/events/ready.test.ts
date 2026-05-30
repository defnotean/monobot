import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Collection } from "discord.js";

// ready.execute() is the bot bootstrap: gatekeep sweep (leave unauthorized
// guilds / backfill whitelist), cache warming, temp-VC restore, reminder
// restore, then presence + the 4 background intervals. Every collaborator is
// mocked; fake timers prevent setInterval/setTimeout leaks.

vi.mock("../../config.js", () => ({ default: { ownerId: "owner-1", aiProvider: "gemini", geminiKeys: [] } }));

const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({ log: (...a: any[]) => log(...a), sendModLog: vi.fn() }));

const updatePresence = vi.fn();
vi.mock("../../presence.js", () => ({ updatePresence: (...a: any[]) => updatePresence(...a) }));

// These are awaited via `.catch()` in ready.js, so they MUST return a promise.
const checkBirthdays = vi.fn(async () => {});
vi.mock("../../utils/birthday.js", () => ({ checkBirthdays: (...a: any[]) => checkBirthdays(...a) }));
const checkFeeds = vi.fn(async () => {});
vi.mock("../../utils/patchbot.js", () => ({ checkFeeds: (...a: any[]) => checkFeeds(...a) }));
const checkStreams = vi.fn(async () => {});
vi.mock("../../utils/twitch.js", () => ({ checkStreams: (...a: any[]) => checkStreams(...a) }));

vi.mock("../../utils/embeds.js", () => ({ setBotIcon: vi.fn() }));

const cacheInvites = vi.fn(async () => {});
vi.mock("../../utils/invites.js", () => ({ cacheInvites: (...a: any[]) => cacheInvites(...a) }));
const updateStatsChannels = vi.fn(async () => {});
vi.mock("../../utils/stats.js", () => ({ updateStatsChannels: (...a: any[]) => updateStatsChannels(...a) }));

const isWhitelisted = vi.fn(async () => true);
const addToWhitelist = vi.fn(async () => {});
const getReminders = vi.fn(() => [] as any[]);
const removeReminder = vi.fn();
const getAllTempVcs = vi.fn(() => ({}) as any);
const deleteTempVc = vi.fn();
const getRelationship = vi.fn(() => ({ affinity_score: 100 }));
const updateRelationship = vi.fn();
const saveTempVc = vi.fn();
const getServerPersona = vi.fn(() => null);
vi.mock("../../database.js", () => ({
  getGuildSettings: vi.fn(() => ({})),
  setLogChannel: vi.fn(),
  setWelcomeChannel: vi.fn(),
  getReminders: (...a: any[]) => getReminders(...a),
  removeReminder: (...a: any[]) => removeReminder(...a),
  getServerPersona: (...a: any[]) => getServerPersona(...a),
  isWhitelisted: (...a: any[]) => isWhitelisted(...a),
  addToWhitelist: (...a: any[]) => addToWhitelist(...a),
  getAllTempVcs: (...a: any[]) => getAllTempVcs(...a),
  deleteTempVc: (...a: any[]) => deleteTempVc(...a),
  getLockdown: vi.fn(() => null),
  clearLockdown: vi.fn(),
  getAutoSlowmodes: vi.fn(() => []),
  clearSlowmode: vi.fn(),
  getGiveawayDb: vi.fn(() => ({})),
  getHighlightDb: vi.fn(() => ({})),
  getSupabase: vi.fn(() => null),
  getMood: vi.fn(() => null),
  getRelationship: (...a: any[]) => getRelationship(...a),
  updateRelationship: (...a: any[]) => updateRelationship(...a),
  saveTempVc: (...a: any[]) => saveTempVc(...a),
}));

// Dynamically imported helpers (await import(...))
vi.mock("../../utils/tempvc.js", () => ({
  tempChannels: new Map(),
  tempTextChannels: new Map(),
  tempVcSeq: new Map(),
  guildVcSeqCounters: new Map(),
  tempControlPanels: new Map(),
  tempVcCreatedAt: new Map(),
  tempVcMembers: new Map(),
}));
vi.mock("../../utils/vcpanel.js", () => ({
  createControlPanel: vi.fn(async () => {}),
  updateControlPanel: vi.fn(async () => {}),
}));
vi.mock("../../events/voiceStateUpdate.js", () => ({ transferOwnership: vi.fn(async () => {}) }));

// @ts-expect-error — JS module, no types
import { execute, name, once, reminderTimers } from "../../events/ready.js";
// The mocked temp-VC Maps are module-level and shared across tests — import
// them so beforeEach can wipe cross-test state that would otherwise make a
// later execute() mis-count or throw.
// @ts-expect-error — JS module, no types
import * as tempvcMock from "../../utils/tempvc.js";

function makeGuild(overrides: any = {}) {
  return {
    id: "g1",
    name: "Guild One",
    ownerId: "owner-1", // bot owner owns it -> authorized
    memberCount: 10,
    iconURL: () => "https://cdn/icon.png",
    leave: vi.fn(async () => {}),
    channels: { cache: new Collection<string, any>(), fetch: vi.fn(async () => {}) },
    roles: { cache: new Collection<string, any>(), fetch: vi.fn(async () => {}) },
    members: {
      cache: new Collection<string, any>(),
      fetch: vi.fn(async () => null),
      fetchMe: vi.fn(async () => null),
    },
    ...overrides,
  };
}

function makeClient({ guilds = [] as any[] } = {}) {
  const gc = new Collection<string, any>();
  for (const g of guilds) gc.set(g.id, g);
  return {
    user: {
      tag: "Irene#0001",
      id: "bot-1",
      displayAvatarURL: () => "https://cdn/bot.png",
      setActivity: vi.fn(),
    },
    commands: new Collection<string, any>(),
    guilds: { cache: gc },
    users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => {}) })) },
    channels: { fetch: vi.fn(async () => null) },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  log.mockClear();
  updatePresence.mockReset();
  cacheInvites.mockReset().mockResolvedValue(undefined);
  updateStatsChannels.mockReset().mockResolvedValue(undefined);
  isWhitelisted.mockReset().mockResolvedValue(true);
  addToWhitelist.mockReset().mockResolvedValue(undefined);
  getReminders.mockReset().mockReturnValue([]);
  removeReminder.mockReset();
  getAllTempVcs.mockReset().mockReturnValue({});
  deleteTempVc.mockReset();
  getRelationship.mockReset().mockReturnValue({ affinity_score: 100 });
  updateRelationship.mockReset();
  checkBirthdays.mockClear().mockResolvedValue(undefined);
  checkFeeds.mockClear().mockResolvedValue(undefined);
  checkStreams.mockClear().mockResolvedValue(undefined);
  // Wipe shared module-level state so tests don't bleed into each other.
  reminderTimers.clear();
  for (const m of Object.values(tempvcMock) as any[]) {
    if (m && typeof m.clear === "function") m.clear();
  }
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("ready", () => {
  it("is a once-only handler exported as 'clientReady'", () => {
    expect(name).toBe("clientReady");
    expect(once).toBe(true);
  });

  it("starts background interval jobs and runs the startup birthday/feed/stream checks", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    try {
      await execute(makeClient());
      // The handler wires up several recurring jobs (stats, birthday, digest,
      // seasonal, patch, twitch, personality, etc.) — assert it scheduled a
      // meaningful number rather than an exact count that's brittle to edits.
      expect(setIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
      // The one-shot startup checks fire immediately.
      expect(checkBirthdays).toHaveBeenCalled();
      expect(checkFeeds).toHaveBeenCalled();
      expect(checkStreams).toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("grabs initial presence from the owner's cached member when available", async () => {
    const ownerMember = { presence: { status: "online", activities: [] } };
    const memberCache = new Collection<string, any>();
    memberCache.set("owner-1", ownerMember);
    const guild = makeGuild({
      id: "g1",
      ownerId: "owner-1",
      members: { cache: memberCache, fetch: vi.fn(async () => null), fetchMe: vi.fn(async () => null) },
    });
    await execute(makeClient({ guilds: [guild] }));
    expect(updatePresence).toHaveBeenCalledWith(ownerMember.presence);
  });

  it("tops up the creator's affinity to 100 when below", async () => {
    getRelationship.mockReturnValue({ affinity_score: 40 });
    await execute(makeClient());
    expect(updateRelationship).toHaveBeenCalledWith("owner-1", 60);
  });

  it("does NOT touch affinity when already maxed", async () => {
    getRelationship.mockReturnValue({ affinity_score: 100 });
    await execute(makeClient());
    expect(updateRelationship).not.toHaveBeenCalled();
  });

  it("gatekeep: leaves an unauthorized server (not owned, not whitelisted, owner not a member)", async () => {
    isWhitelisted.mockResolvedValue(false);
    const guild = makeGuild({
      id: "bad",
      ownerId: "someone-else",
      members: {
        cache: new Collection<string, any>(),
        fetch: vi.fn(async () => null), // owner not a member
        fetchMe: vi.fn(async () => null),
      },
    });
    await execute(makeClient({ guilds: [guild] }));
    expect(guild.leave).toHaveBeenCalled();
    // Left before backfilling -> not whitelisted.
    expect(addToWhitelist).not.toHaveBeenCalled();
  });

  it("gatekeep: backfills the whitelist for an authorized-but-untracked guild", async () => {
    isWhitelisted.mockResolvedValue(false);
    const guild = makeGuild({ id: "g1", ownerId: "owner-1" }); // owned by bot owner => authorized
    await execute(makeClient({ guilds: [guild] }));
    expect(guild.leave).not.toHaveBeenCalled();
    expect(addToWhitelist).toHaveBeenCalledWith(
      "g1",
      expect.objectContaining({ name: "Guild One" }),
    );
  });

  it("warms channel + role caches for each guild", async () => {
    const guild = makeGuild();
    await execute(makeClient({ guilds: [guild] }));
    expect(guild.channels.fetch).toHaveBeenCalled();
    expect(guild.roles.fetch).toHaveBeenCalled();
    expect(cacheInvites).toHaveBeenCalled();
  });

  it("temp-VC restore: deletes an orphan row whose guild is gone", async () => {
    getAllTempVcs.mockReturnValue({ "vc-1": { guildId: "missing-guild" } });
    await execute(makeClient({ guilds: [] }));
    expect(deleteTempVc).toHaveBeenCalledWith("vc-1");
  });

  it("temp-VC restore: deletes a row when the live channel is empty of non-bots", async () => {
    const emptyVc: any = {
      id: "vc-2",
      members: new Collection<string, any>(), // .filter -> size 0
      permissionOverwrites: { cache: new Collection() },
    };
    const channelCache = new Collection<string, any>();
    channelCache.set("vc-2", emptyVc);
    const guild = makeGuild({ id: "g1", channels: { cache: channelCache, fetch: vi.fn(async () => {}) } });
    getAllTempVcs.mockReturnValue({ "vc-2": { guildId: "g1" } });
    await execute(makeClient({ guilds: [guild] }));
    expect(deleteTempVc).toHaveBeenCalledWith("vc-2");
  });

  it("reminder restore: fires an overdue reminder immediately (DM fallback) and removes it", async () => {
    const client = makeClient();
    const sent = vi.fn(async () => {});
    client.users.fetch = vi.fn(async () => ({ send: sent }));
    // Source keys off fireAt (epoch ms) + userId/message; no guild/channel here
    // so it takes the DM fallback path.
    getReminders.mockReturnValue([
      { id: "rem-1", userId: "user-1", message: "drink water", fireAt: Date.now() - 1000 },
    ]);

    await execute(client);
    // Overdue reminders fire via an async IIFE (no timer). Drain microtasks
    // WITHOUT advancing the clock — advancing it would re-trigger ready.js's
    // self-rescheduling interval jobs forever.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(client.users.fetch).toHaveBeenCalledWith("user-1");
    expect(sent).toHaveBeenCalledWith(expect.stringContaining("drink water"));
    expect(removeReminder).toHaveBeenCalledWith("rem-1");
    // Overdue reminders are not tracked as pending timers.
    expect(reminderTimers.has("rem-1")).toBe(false);
  });

  it("reminder restore: delivers to the reminder's channel when guild+channel resolve", async () => {
    const send = vi.fn(async () => {});
    const channelCache = new Collection<string, any>();
    channelCache.set("chan-1", { send });
    const guild = makeGuild({ id: "g1", channels: { cache: channelCache, fetch: vi.fn(async () => {}) } });
    const client = makeClient({ guilds: [guild] });
    getReminders.mockReturnValue([
      { id: "rem-c", userId: "user-1", guildId: "g1", channelId: "chan-1", message: "standup", fireAt: Date.now() - 1000 },
    ]);

    await execute(client);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("standup"));
    expect(removeReminder).toHaveBeenCalledWith("rem-c");
  });

  it("reminder restore: schedules a future reminder via setTimeout (registers timer, does not fire)", async () => {
    const client = makeClient();
    const sent = vi.fn(async () => {});
    client.users.fetch = vi.fn(async () => ({ send: sent }));
    getReminders.mockReturnValue([
      { id: "rem-2", userId: "user-2", message: "soon", fireAt: Date.now() + 60_000 },
    ]);

    await execute(client);
    // Drain microtasks (no clock advance) so any immediate work settles.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Future reminders (delay > 0) are scheduled and tracked, not fired now.
    expect(sent).not.toHaveBeenCalled();
    expect(removeReminder).not.toHaveBeenCalled();
    expect(reminderTimers.has("rem-2")).toBe(true);
  });
});
