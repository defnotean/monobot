// Tests for the guildCreate event handler — the owner-only gatekeep + auto-setup.
//
// This is the logic-heavy one: it decides whether to LEAVE an unauthorized guild
// (3 allow conditions), auto-tracks the guild in the shared whitelist, and
// auto-detects log/welcome channels by name. We mock database.js + config.js so
// the allow/deny branches and the DB writes are observable, and use plain fake
// guild objects with spied leave()/fetch().

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collection } from "discord.js";

// ── config: pin a known owner id ──────────────────────────────────────────────
vi.mock("../../config.js", () => ({ default: { ownerId: "OWNER-123" } }));

// ── logger: silence ───────────────────────────────────────────────────────────
vi.mock("../../utils/logger.js", () => ({ log: vi.fn(), sendModLog: vi.fn() }));

// ── database: spy on every read/write the handler performs ────────────────────
const isWhitelisted = vi.fn(async () => false);
const addToWhitelist = vi.fn(async () => {});
const getGuildSettings = vi.fn(() => ({}));
const setLogChannel = vi.fn();
const setWelcomeChannel = vi.fn();
vi.mock("../../database.js", () => ({
  isWhitelisted,
  addToWhitelist,
  getGuildSettings,
  setLogChannel,
  setWelcomeChannel,
}));

function makeTextChannel(name: string) {
  return { id: `chan-${name}`, name, isTextBased: () => true };
}

function makeGuild(overrides: Record<string, unknown> = {}) {
  const channelCache = new Collection<string, any>();
  const memberCache = new Collection<string, any>();
  const guild: any = {
    id: "G-1",
    name: "Some Server",
    memberCount: 10,
    ownerId: "SERVER-OWNER",
    leave: vi.fn(async () => {}),
    iconURL: () => "http://icon",
    members: {
      cache: memberCache,
      fetch: vi.fn(async () => {}),
    },
    channels: {
      cache: channelCache,
      fetch: vi.fn(async () => {}),
    },
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => null } })),
    client: { users: { fetch: vi.fn(async () => ({ username: "BotOwner" })) } },
    ...overrides,
  };
  return guild;
}

beforeEach(() => {
  isWhitelisted.mockReset().mockResolvedValue(false);
  addToWhitelist.mockReset().mockResolvedValue(undefined);
  getGuildSettings.mockReset().mockReturnValue({});
  setLogChannel.mockReset();
  setWelcomeChannel.mockReset();
});

describe("guildCreate gatekeep", () => {
  it("LEAVES an unauthorized guild and never auto-tracks it", async () => {
    const mod = await import("../../events/guildCreate.js");
    const guild = makeGuild(); // owner != bot owner, not whitelisted, owner not a member
    await mod.execute(guild);

    expect(guild.leave).toHaveBeenCalledTimes(1);
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(setLogChannel).not.toHaveBeenCalled();
  });

  it("DMs the inviter (audit-log BOT_ADD executor) before leaving an unauthorized guild", async () => {
    const mod = await import("../../events/guildCreate.js");
    const inviterSend = vi.fn(async () => {});
    const guild = makeGuild({
      fetchAuditLogs: vi.fn(async () => ({
        entries: { first: () => ({ executor: { send: inviterSend } }) },
      })),
    });
    await mod.execute(guild);
    expect(inviterSend).toHaveBeenCalledTimes(1);
    expect(String(inviterSend.mock.calls[0][0])).toContain("private bot");
    expect(guild.leave).toHaveBeenCalledTimes(1);
  });

  it("STAYS when the bot owner is the server owner", async () => {
    const mod = await import("../../events/guildCreate.js");
    const guild = makeGuild({ ownerId: "OWNER-123" });
    await mod.execute(guild);
    expect(guild.leave).not.toHaveBeenCalled();
    // auto-tracked because not previously whitelisted
    expect(addToWhitelist).toHaveBeenCalledTimes(1);
    expect(addToWhitelist.mock.calls[0][0]).toBe("G-1");
    expect(addToWhitelist.mock.calls[0][1]).toMatchObject({ invited_by: "auto-tracked-on-join" });
  });

  it("STAYS when the guild is already whitelisted, and does NOT re-track it", async () => {
    const mod = await import("../../events/guildCreate.js");
    isWhitelisted.mockResolvedValue(true);
    const guild = makeGuild(); // owner mismatch but whitelisted
    await mod.execute(guild);
    expect(guild.leave).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled(); // already present -> skip
  });

  it("STAYS when the bot owner is a member of the guild", async () => {
    const mod = await import("../../events/guildCreate.js");
    const guild = makeGuild();
    guild.members.cache.set("OWNER-123", { id: "OWNER-123" });
    await mod.execute(guild);
    expect(guild.leave).not.toHaveBeenCalled();
    expect(addToWhitelist).toHaveBeenCalledTimes(1);
  });
});

describe("guildCreate auto-setup", () => {
  it("auto-detects a log channel by name and persists it when none configured", async () => {
    const mod = await import("../../events/guildCreate.js");
    const guild = makeGuild({ ownerId: "OWNER-123" });
    const modLog = makeTextChannel("mod-log");
    guild.channels.cache.set(modLog.id, modLog);
    await mod.execute(guild);
    expect(setLogChannel).toHaveBeenCalledWith("G-1", modLog.id);
  });

  it("does NOT overwrite an already-configured log channel", async () => {
    const mod = await import("../../events/guildCreate.js");
    getGuildSettings.mockReturnValue({ log_channel: "existing" });
    const guild = makeGuild({ ownerId: "OWNER-123" });
    guild.channels.cache.set("c", makeTextChannel("logs"));
    await mod.execute(guild);
    expect(setLogChannel).not.toHaveBeenCalled();
  });

  it("auto-detects a welcome channel by name", async () => {
    const mod = await import("../../events/guildCreate.js");
    const guild = makeGuild({ ownerId: "OWNER-123" });
    const wc = makeTextChannel("introductions");
    guild.channels.cache.set(wc.id, wc);
    await mod.execute(guild);
    expect(setWelcomeChannel).toHaveBeenCalledWith("G-1", wc.id, null);
  });

  it("ignores non-matching channel names", async () => {
    const mod = await import("../../events/guildCreate.js");
    const guild = makeGuild({ ownerId: "OWNER-123" });
    guild.channels.cache.set("c", makeTextChannel("random-chat"));
    await mod.execute(guild);
    expect(setLogChannel).not.toHaveBeenCalled();
    expect(setWelcomeChannel).not.toHaveBeenCalled();
  });
});
