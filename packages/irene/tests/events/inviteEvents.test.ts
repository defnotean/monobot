// Tests for inviteCreate / inviteDelete root-level event handlers.
//
// Both guard on invite.guild, mutate the shared `guildInvites` cache from
// utils/invites.js, and emit a mod-log embed via utils/logger.sendModLog built
// by utils/embeds.logEvent. We mock the logger + embeds sinks and use a real
// Map-of-Maps for guildInvites so we can assert the cache is actually updated
// (create) and purged (delete), plus the audit-log attribution branches.

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({ sendModLog, log: vi.fn() }));

const logEvent = vi.fn((opts: unknown) => ({ logEvent: opts }));
vi.mock("../../utils/embeds.js", () => ({
  logEvent,
  logEmbed: vi.fn(() => ({ addFields: () => ({}), setFooter: () => ({}) })),
  modEmbed: vi.fn(() => ({ setFooter: () => ({}) })),
  LC: { message: 0 },
}));

// Real in-memory cache so we can observe mutations.
const guildInvites = new Map<string, Map<string, any>>();
vi.mock("../../utils/invites.js", () => ({ guildInvites }));

function auditResult(entries: any[]) {
  return {
    entries: {
      first: () => entries[0] ?? null,
      find: (fn: (e: any) => boolean) => entries.find(fn) ?? null,
    },
  };
}

function fakeGuild(overrides: Record<string, unknown> = {}) {
  return {
    id: "g-1",
    name: "Guild",
    fetchAuditLogs: vi.fn(async () => auditResult([])),
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
  guildInvites.clear();
});

describe("inviteCreate", () => {
  it("ignores invites with no guild", async () => {
    const mod = await import("../../events/inviteCreate.js");
    await mod.execute({ guild: null, code: "abc" } as any);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("updates the existing guild invite cache with the new code's stats", async () => {
    const mod = await import("../../events/inviteCreate.js");
    const guild = fakeGuild();
    guildInvites.set(guild.id, new Map()); // a cache already exists for this guild
    const invite = {
      guild, code: "newcode", uses: 0, maxUses: 10, maxAge: 3600,
      inviter: { id: "inv-1", tag: "inviter#1", bot: false },
      channel: { id: "ch-1", name: "general" },
      temporary: false,
    };
    await mod.execute(invite as any);

    const cached = guildInvites.get(guild.id)!.get("newcode");
    expect(cached).toBeTruthy();
    expect(cached.uses).toBe(0);
    expect(cached.inviter).toBe(invite.inviter);
    expect(cached.maxUses).toBe(10);
    expect(sendModLog).toHaveBeenCalledTimes(1);
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.title).toBe("Invite Created");
    expect(opts.actor).toBe(invite.inviter);
    // finite maxAge -> a real "Expires" timestamp, not "never"
    expect(opts.meta["Expires"]).not.toBe("never");
    expect(opts.meta["Max Uses"]).toBe("10");
  });

  it("does not create a cache entry when no cache exists yet, but still logs", async () => {
    const mod = await import("../../events/inviteCreate.js");
    const guild = fakeGuild(); // no guildInvites.set -> cached is undefined
    const invite = {
      guild, code: "nocache", uses: 5, maxUses: 0, maxAge: 0,
      inviter: null, channel: { id: "ch-2", name: "lobby" }, temporary: true,
    };
    await mod.execute(invite as any);
    expect(guildInvites.has(guild.id)).toBe(false);
    const opts = logEvent.mock.calls[0][0] as any;
    // maxAge 0 -> never expires; maxUses 0 -> unlimited; no inviter -> vanity wording
    expect(opts.meta["Expires"]).toBe("never");
    expect(opts.meta["Max Uses"]).toBe("unlimited");
    expect(opts.meta["Created By"]).toContain("unknown");
  });
});

describe("inviteDelete", () => {
  it("ignores invites with no guild", async () => {
    const mod = await import("../../events/inviteDelete.js");
    await mod.execute({ guild: null, code: "x" } as any);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("purges the cached entry and surfaces the prior inviter/uses in the embed", async () => {
    const mod = await import("../../events/inviteDelete.js");
    const guild = fakeGuild();
    const prior = { inviter: { id: "inv-9", tag: "inv#9", bot: false }, uses: 7 };
    const inner = new Map([["gone", prior]]);
    guildInvites.set(guild.id, inner);

    await mod.execute({ guild, code: "gone", channel: { id: "c", name: "n" } } as any);

    expect(inner.has("gone")).toBe(false); // cache purged
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.title).toBe("Invite Deleted");
    expect(opts.meta["Was Created By"]).toContain("inv#9");
    expect(opts.meta["Uses at Deletion"]).toBe("7");
  });

  it("attributes deletion to a recent audit-log executor", async () => {
    const mod = await import("../../events/inviteDelete.js");
    const executor = { id: "mod-3", tag: "mod#3", bot: false };
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ executor, reason: "cleanup", createdTimestamp: Date.now() }]),
      ),
    });
    await mod.execute({ guild, code: "z", channel: null } as any);
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.actor).toBe(executor);
    expect(opts.reason).toBe("cleanup");
    expect(opts.meta["Deleted By"]).toContain("mod#3");
  });

  it("marks deleter unknown when the audit entry is stale", async () => {
    const mod = await import("../../events/inviteDelete.js");
    const guild = fakeGuild({
      fetchAuditLogs: vi.fn(async () =>
        auditResult([{ executor: { id: "m", tag: "m#1" }, createdTimestamp: Date.now() - 9000 }]),
      ),
    });
    await mod.execute({ guild, code: "z2", channel: null } as any);
    const opts = logEvent.mock.calls[0][0] as any;
    expect(opts.actor).toBeNull();
    expect(opts.meta["Deleted By"]).toContain("unknown");
  });
});
