// Tests for root-level event handlers (basename g–n) that emit audit/mod-log
// embeds: guildAuditLogEntryCreate, guildBanRemove, guildScheduledEventCreate,
// guildScheduledEventDelete, messageBulkDelete, messageDelete.
//
// These handlers all funnel into sendModLog(guild, embed) from utils/logger.js
// and build their payload via utils/embeds.js. We mock those sinks so we can
// assert on the REAL branching inside each handler (tracked-vs-untracked action
// types, audit-log time-window matching, bot/guild guards, partial handling)
// without depending on the embed/logger implementation details or hitting
// Discord. EmbedBuilder-shaped objects are not produced (embeds.js is mocked),
// so handlers' .setFooter()/.addFields() chaining is stubbed to be chainable.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the logger sink: capture (guild, embed) passed to sendModLog ──────────
const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog,
  log: vi.fn(),
}));

// ── Mock the embeds builders: return a chainable stub that records its inputs ──
function makeEmbedStub(seed: Record<string, unknown> = {}) {
  const stub: any = {
    ...seed,
    _footer: null,
    _fields: [] as unknown[],
    setFooter(f: unknown) { this._footer = f; return this; },
    addFields(...f: unknown[]) {
      this._fields.push(...(f.length === 1 && Array.isArray(f[0]) ? (f[0] as unknown[]) : f));
      return this;
    },
    setAuthor(a: unknown) { this._author = a; return this; },
    setThumbnail(t: unknown) { this._thumb = t; return this; },
  };
  return stub;
}
const modEmbed = vi.fn((title: string, desc: string) => makeEmbedStub({ title, desc }));
const logEmbed = vi.fn((title: string) => makeEmbedStub({ title }));
const logEvent = vi.fn((opts: unknown) => makeEmbedStub({ logEvent: opts }));
vi.mock("../../utils/embeds.js", () => ({
  modEmbed,
  logEmbed,
  logEvent,
  LC: { message: 0x111111, audit: 0x222222 },
}));

// snipe.js is imported by messageDelete — mock its side-effect.
const cacheDeletedMessage = vi.fn();
vi.mock("../../utils/snipe.js", () => ({ cacheDeletedMessage }));

// AuditLogEvent constant used by messageDelete — provide just the field it reads.
vi.mock("discord.js", async () => {
  const actual = await vi.importActual<any>("discord.js");
  return { ...actual, AuditLogEvent: { ...actual.AuditLogEvent, MessageDelete: 72 } };
});

// Build a minimal audit-log result object the handlers iterate over.
function auditResult(entries: any[]) {
  return {
    entries: {
      first: () => entries[0] ?? null,
      find: (fn: (e: any) => boolean) => entries.find(fn) ?? null,
      values: () => entries.values(),
    },
  };
}

function fakeGuild(overrides: Record<string, unknown> = {}) {
  return {
    id: "guild-1",
    name: "Test Guild",
    fetchAuditLogs: vi.fn(async () => auditResult([])),
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  modEmbed.mockClear();
  logEmbed.mockClear();
  logEvent.mockClear();
  cacheDeletedMessage.mockClear();
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────────────────────
describe("guildAuditLogEntryCreate", () => {
  it("logs a tracked action (Webhook Created) with executor/target/reason wired into the embed", async () => {
    const mod = await import("../../events/guildAuditLogEntryCreate.js");
    const guild = fakeGuild();
    const entry = {
      action: 50, // Webhook Created (tracked)
      executor: { tag: "mod#0001" },
      target: { name: "my-webhook" },
      reason: "spam cleanup",
    };
    await mod.execute(entry, guild);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(modEmbed).toHaveBeenCalledTimes(1);
    const [title, body] = modEmbed.mock.calls[0];
    expect(title).toContain("Webhook Created");
    // executor tag, target name, and reason must all appear in the description
    expect(body).toContain("my-webhook");
    expect(body).toContain("mod#0001");
    expect(body).toContain("spam cleanup");
    // footer carries the numeric action code
    const embed = sendModLog.mock.calls[0][1] as any;
    expect(embed._footer).toEqual({ text: "Action #50" });
  });

  it("returns silently for an untracked action and never logs", async () => {
    const mod = await import("../../events/guildAuditLogEntryCreate.js");
    const guild = fakeGuild();
    // action 1 is not present in TRACKED at all -> label undefined -> early return
    await mod.execute({ action: 1, executor: { tag: "x" } }, guild);
    expect(sendModLog).not.toHaveBeenCalled();
    expect(modEmbed).not.toHaveBeenCalled();
  });

  it("returns silently for an explicitly-null tracked entry (handled elsewhere, e.g. action 73)", async () => {
    const mod = await import("../../events/guildAuditLogEntryCreate.js");
    const guild = fakeGuild();
    await mod.execute({ action: 73 }, guild); // bulk delete -> null label
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("falls back to targetId when target has no name/tag", async () => {
    const mod = await import("../../events/guildAuditLogEntryCreate.js");
    const guild = fakeGuild();
    await mod.execute({ action: 80, targetId: "999", target: null }, guild);
    const [, body] = modEmbed.mock.calls[0];
    expect(body).toContain("999");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("guildBanRemove", () => {
  it("attributes the unban to the audit-log executor when the entry matches the user inside the time window", async () => {
    const mod = await import("../../events/guildBanRemove.js");
    const executor = { id: "mod-7", tag: "mod#7" };
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ target: { id: "banned-1" }, executor, createdTimestamp: Date.now() }]),
      ),
    });
    const ban = { guild, user: { id: "banned-1", tag: "victim#1" } };
    await mod.execute(ban);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledTimes(1);
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.kind).toBe("unban");
    expect(opts.target).toBe(ban.user);
    expect(opts.actor).toBe(executor); // matched -> actor populated
  });

  it("leaves actor null when the audit entry is for a different user", async () => {
    const mod = await import("../../events/guildBanRemove.js");
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ target: { id: "someone-else" }, executor: { id: "m" }, createdTimestamp: Date.now() }]),
      ),
    });
    const ban = { guild, user: { id: "banned-1" } };
    await mod.execute(ban);
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.actor).toBeNull();
  });

  it("leaves actor null when the audit entry is stale (older than 5s)", async () => {
    const mod = await import("../../events/guildBanRemove.js");
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ target: { id: "banned-1" }, executor: { id: "m" }, createdTimestamp: Date.now() - 9000 }]),
      ),
    });
    await mod.execute({ guild, user: { id: "banned-1" } });
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.actor).toBeNull();
  });

  it("still logs the unban when fetchAuditLogs throws (no perms)", async () => {
    const mod = await import("../../events/guildBanRemove.js");
    const guild = fakeGuild({ fetchAuditLogs: vi.fn(async () => { throw new Error("missing perms"); }) });
    await mod.execute({ guild, user: { id: "banned-1" } });
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect((logEvent.mock.calls[0][0] as any).actor).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("guildScheduledEventCreate", () => {
  it("uses event.creator directly and skips the audit-log lookup", async () => {
    const mod = await import("../../events/guildScheduledEventCreate.js");
    const fetchAuditLogs = vi.fn();
    const guild = fakeGuild({ fetchAuditLogs });
    const event = {
      id: "evt-1",
      name: "Game Night",
      guild,
      creator: { id: "host-1", tag: "host#1", bot: false },
      scheduledStartTimestamp: 1_700_000_000_000,
      scheduledEndTimestamp: null,
      entityType: 2,
      privacyLevel: 2,
      channelId: "vc-1",
    };
    await mod.execute(event);
    expect(fetchAuditLogs).not.toHaveBeenCalled(); // creator present -> no lookup
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.title).toBe("Event Scheduled");
    expect(opts.actor).toBe(event.creator);
    expect(opts.meta.Type).toBe("Voice");
    expect(opts.meta.Privacy).toBe("Guild Only");
  });

  it("falls back to the audit-log executor when there is no creator", async () => {
    const mod = await import("../../events/guildScheduledEventCreate.js");
    const executor = { id: "host-2", tag: "host#2", bot: false };
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ target: { id: "evt-2" }, executor, createdTimestamp: Date.now() }]),
      ),
    });
    const event = {
      id: "evt-2",
      name: "Stream",
      guild,
      creator: null,
      scheduledStartTimestamp: 1_700_000_000_000,
      scheduledEndTimestamp: 1_700_003_600_000,
      entityType: 3,
      privacyLevel: 2,
      channelId: null,
      entityMetadata: { location: "Twitch" },
    };
    await mod.execute(event);
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.actor).toBe(executor);
    expect(opts.meta.Type).toBe("External");
    expect(opts.meta.Location).toContain("Twitch");
    expect(opts.meta.Ends).not.toBeNull(); // end timestamp branch
  });

  it("renders an unknown entity type by its numeric code", async () => {
    const mod = await import("../../events/guildScheduledEventCreate.js");
    const guild = fakeGuild();
    await mod.execute({
      id: "evt-3", name: "?", guild, creator: { id: "c", tag: "c#1", bot: false },
      scheduledStartTimestamp: 1_700_000_000_000, scheduledEndTimestamp: null,
      entityType: 99, privacyLevel: 7, channelId: null,
    });
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.meta.Type).toBe("type 99");
    expect(opts.meta.Privacy).toBe("level 7");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("guildScheduledEventDelete", () => {
  it("records the canceller and reason from a matching recent audit entry", async () => {
    const mod = await import("../../events/guildScheduledEventDelete.js");
    const executor = { id: "mod-1", tag: "mod#1", bot: false };
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ target: { id: "evt-9" }, executor, reason: "duplicate", createdTimestamp: Date.now() }]),
      ),
    });
    await mod.execute({ id: "evt-9", name: "Old", guild, scheduledStartTimestamp: 1_700_000_000_000, userCount: 5 });
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.title).toBe("Event Cancelled");
    expect(opts.actor).toBe(executor);
    expect(opts.reason).toBe("duplicate");
    expect(opts.meta["Subscriber Count"]).toBe("5");
  });

  it("marks canceller unknown when audit lookup yields nothing", async () => {
    const mod = await import("../../events/guildScheduledEventDelete.js");
    const guild = fakeGuild();
    await mod.execute({ id: "evt-10", name: "X", guild, scheduledStartTimestamp: null, userCount: null });
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.actor).toBeNull();
    expect(opts.reason).toBeUndefined();
    expect(opts.meta["Cancelled By"]).toContain("unknown");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("messageBulkDelete", () => {
  it("ignores deletions outside a guild", async () => {
    const mod = await import("../../events/messageBulkDelete.js");
    await mod.execute({ size: 3 }, { id: "c1", guild: null });
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("reports the channel, count and moderator from the audit log", async () => {
    const mod = await import("../../events/messageBulkDelete.js");
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ executor: { tag: "purger#1" }, createdTimestamp: Date.now() }]),
      ),
    });
    const channel = { id: "chan-77", guild };
    const messages = { size: 42 };
    await mod.execute(messages, channel);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    const embed = sendModLog.mock.calls[0][1] as any;
    const fields = embed._fields as any[];
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName["Messages Deleted"]).toBe("42");
    expect(byName["Deleted By"]).toBe("purger#1");
    expect(byName["Channel"]).toBe("<#chan-77>");
  });

  it("falls back to \"unknown\" moderator when the audit entry is stale", async () => {
    const mod = await import("../../events/messageBulkDelete.js");
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ executor: { tag: "purger#1" }, createdTimestamp: Date.now() - 9000 }]),
      ),
    });
    await mod.execute({ size: 1 }, { id: "c", guild });
    const embed = sendModLog.mock.calls[0][1] as any;
    const byName = Object.fromEntries((embed._fields as any[]).map((f) => [f.name, f.value]));
    expect(byName["Deleted By"]).toBe("unknown");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("messageDelete", () => {
  it("ignores DM (no-guild) deletions: returns before caching or logging", async () => {
    // Source order: the `if (!message.guild) return;` guard runs BEFORE
    // cacheDeletedMessage(message), so a DM deletion neither caches nor logs.
    const mod = await import("../../events/messageDelete.js");
    const message = { partial: false, guild: null, author: { bot: false }, content: "hi", id: "m1" };
    await mod.execute(message as any);
    expect(cacheDeletedMessage).not.toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("skips bot-authored messages", async () => {
    const mod = await import("../../events/messageDelete.js");
    const guild = fakeGuild();
    const message = { partial: false, guild, author: { bot: true }, content: "x", id: "m2", channelId: "c2" };
    await mod.execute(message as any);
    expect(cacheDeletedMessage).toHaveBeenCalled();
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a non-bot deletion with author + channel + content fields", async () => {
    vi.useFakeTimers();
    const mod = await import("../../events/messageDelete.js");
    const guild = fakeGuild(); // empty audit -> no deletedBy
    const author = {
      id: "u-1", bot: false, tag: "victim#1", username: "victim",
      displayAvatarURL: vi.fn(() => "http://a"),
    };
    const message = { partial: false, guild, author, content: "secret message", id: "m3", channelId: "c3" };
    const p = mod.execute(message as any);
    await vi.advanceTimersByTimeAsync(700); // clear the 600ms audit delay
    await p;
    vi.useRealTimers();

    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(logEmbed).toHaveBeenCalledWith("Message Deleted", expect.anything());
    const embed = sendModLog.mock.calls[0][1] as any;
    const byName = Object.fromEntries((embed._fields as any[]).map((f) => [f.name, f.value]));
    expect(byName["Author"]).toBe("<@u-1>");
    expect(byName["Channel"]).toBe("<#c3>");
    expect(byName["Content"]).toBe("secret message");
    // no separate "Deleted By" field because audit log was empty
    expect(byName["Deleted By"]).toBeUndefined();
  });

  it("adds a \"Deleted By\" field when a different moderator deleted it", async () => {
    vi.useFakeTimers();
    const mod = await import("../../events/messageDelete.js");
    const author = { id: "u-2", bot: false, tag: "v#2", username: "v", displayAvatarURL: vi.fn(() => "") };
    const deleter = { id: "mod-9", bot: false };
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ extra: { channel: { id: "c4" } }, executor: deleter, target: author, createdTimestamp: Date.now() }]),
      ),
    });
    const message = { partial: false, guild, author, content: "bye", id: "m4", channelId: "c4" };
    const p = mod.execute(message as any);
    await vi.advanceTimersByTimeAsync(700);
    await p;
    vi.useRealTimers();

    const embed = sendModLog.mock.calls[0][1] as any;
    const byName = Object.fromEntries((embed._fields as any[]).map((f) => [f.name, f.value]));
    expect(byName["Deleted By"]).toBe("<@mod-9>");
  });
});
