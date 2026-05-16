import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock collaborators ──────────────────────────────────────────────────────
// The handler reaches out to a mod-log channel, a warning store, the voice
// state's "recent removal" tracker, and the in-memory message-evidence buffer.
// Each is mocked so we can observe what guildBanAdd actually does without
// touching Discord, Supabase, or other event handlers.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));

const getWarnings = vi.fn(() => []);
vi.mock("../../database.js", () => ({
  getWarnings: (...args: any[]) => getWarnings(...args),
}));

const recordServerRemoval = vi.fn();
vi.mock("../../events/voiceStateUpdate.js", () => ({
  recordServerRemoval: (...args: any[]) => recordServerRemoval(...args),
}));

const getEvidence = vi.fn(() => [] as any[]);
const formatEvidence = vi.fn(() => "");
vi.mock("../../utils/messageEvidence.js", () => ({
  getEvidence: (...args: any[]) => getEvidence(...args),
  formatEvidence: (...args: any[]) => formatEvidence(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/guildBanAdd.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeUser(overrides: any = {}) {
  return {
    id: "user-1",
    tag: "spammer#0001",
    bot: false,
    createdTimestamp: Date.now() - 365 * 86_400_000, // 1y old
    displayAvatarURL: () => "https://cdn/avatar.png",
    ...overrides,
  };
}

function makeGuild({ auditEntries = null, fetchThrows = false, members = new Map() }: any = {}) {
  const guild: any = {
    id: "guild-1",
    name: "Test Guild",
    fetchAuditLogs: vi.fn(async () => {
      if (fetchThrows) throw new Error("Missing permission");
      return { entries: { values: () => (auditEntries ?? []).values() } };
    }),
    members: {
      cache: members,
    },
  };
  return guild;
}

function makeBan({ user = makeUser(), reason = null, guildOpts = {} }: any = {}) {
  const guild = makeGuild(guildOpts);
  return { user, reason, guild };
}

beforeEach(() => {
  sendModLog.mockClear();
  getWarnings.mockClear();
  getWarnings.mockReturnValue([]);
  recordServerRemoval.mockClear();
  getEvidence.mockClear();
  getEvidence.mockReturnValue([]);
  formatEvidence.mockClear();
  formatEvidence.mockReturnValue("");
});

// The handler waits 1200ms between two audit-log lookups for eventual
// consistency. We stub setTimeout so tests don't sleep — Promises with no
// real timer dependency resolve immediately.
const _origSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  // @ts-expect-error — replace setTimeout with an immediate resolver
  globalThis.setTimeout = ((fn: any) => { fn(); return 0; }) as any;
});
afterEach(() => {
  globalThis.setTimeout = _origSetTimeout;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("guildBanAdd", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("guildBanAdd");
  });

  it("sends a mod-log entry to the audit channel for every ban", async () => {
    const ban = makeBan({ reason: "spam" });
    await execute(ban);
    expect(sendModLog).toHaveBeenCalledTimes(1);
    const [guildArg, embed] = sendModLog.mock.calls[0];
    expect(guildArg).toBe(ban.guild);
    // logEvent returns an EmbedBuilder — confirm the ban kind by author text.
    expect(embed.data.author.name).toMatch(/Banned/i);
  });

  it("includes the ban reason when present on the ban payload", async () => {
    const ban = makeBan({ reason: "raiding the server" });
    await execute(ban);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("raiding the server");
  });

  it("falls back to 'no reason provided' when reason and audit are empty", async () => {
    const ban = makeBan({ reason: null });
    await execute(ban);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("no reason provided");
  });

  it("records moderator from audit log when fetch succeeds", async () => {
    const moderator = { id: "mod-9", tag: "modtag#0001" };
    const ban = makeBan({
      user: makeUser({ id: "victim-2" }),
      reason: null,
      guildOpts: {
        auditEntries: [
          {
            target: { id: "victim-2" },
            executor: moderator,
            reason: "ban hammer",
            createdTimestamp: Date.now() - 1000,
          },
        ],
      },
    });

    await execute(ban);

    // recordServerRemoval should receive the moderator + audit reason.
    expect(recordServerRemoval).toHaveBeenCalledWith(
      "guild-1",
      "victim-2",
      "ban",
      moderator,
      "ban hammer",
    );
    // Embed picks up the audit reason as well.
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("ban hammer");
  });

  it("skips audit entries older than 15s when matching", async () => {
    const ban = makeBan({
      user: makeUser({ id: "victim-3" }),
      reason: "fallback reason",
      guildOpts: {
        auditEntries: [
          {
            target: { id: "victim-3" },
            executor: { id: "stale-mod", tag: "stale#0001" },
            reason: "stale audit",
            createdTimestamp: Date.now() - 60_000, // 1 minute ago — too old
          },
        ],
      },
    });

    await execute(ban);

    // Audit entry is too old, so moderator stays null and reason falls back
    // to whatever the ban payload provided.
    const [, , , actor, reason] = recordServerRemoval.mock.calls[0];
    expect(actor).toBeNull();
    expect(reason).toBe("fallback reason");
  });

  it("still logs gracefully when audit-log fetch throws (missing perms)", async () => {
    const ban = makeBan({
      reason: "still bannable",
      guildOpts: { fetchThrows: true },
    });

    await expect(execute(ban)).resolves.not.toThrow();

    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(recordServerRemoval).toHaveBeenCalledTimes(1);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("still bannable");
  });

  it("flags bot accounts in the embed meta", async () => {
    const ban = makeBan({
      user: makeUser({ id: "bot-victim", tag: "evilbot#0000", bot: true }),
      reason: "rogue bot",
    });

    await execute(ban);

    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("Bot Account");
    expect(embed.data.description).toContain("yes");
  });

  it("includes cached member nickname + role count when member was in cache", async () => {
    const members = new Map();
    const targetId = "cached-user";
    members.set(targetId, {
      nickname: "OldNick",
      joinedTimestamp: Date.now() - 30 * 86_400_000, // 30d
      roles: {
        cache: new Map([
          ["guild-1", { id: "guild-1" }], // @everyone — filtered out
          ["role-a", { id: "role-a" }],
          ["role-b", { id: "role-b" }],
        ]),
      },
    });
    // Map needs a discord.js Collection-like .filter().map() chain; the source
    // calls roles.cache.filter(...).map(...) so build a tiny shim.
    const realCache = members.get(targetId).roles.cache;
    members.get(targetId).roles.cache = {
      filter: (fn: any) => {
        const kept: any[] = [];
        for (const v of realCache.values()) if (fn(v)) kept.push(v);
        return {
          map: (m: any) => kept.map(m),
        };
      },
    };

    const ban = makeBan({
      user: makeUser({ id: targetId }),
      reason: "noise",
      guildOpts: { members },
    });

    await execute(ban);

    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("OldNick");
    // Role field renders with count and mentions.
    const rolesField = (embed.data.fields ?? []).find((f: any) =>
      /Roles at time of ban/.test(f.name),
    );
    expect(rolesField).toBeTruthy();
    expect(rolesField.value).toContain("<@&role-a>");
    expect(rolesField.value).toContain("<@&role-b>");
  });
});
