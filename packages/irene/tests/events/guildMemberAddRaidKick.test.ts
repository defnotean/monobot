import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression for the resilience fix at events/guildMemberAdd.js: the auto-mod
// raid kick used to live inside a fully-silent `catch {}`. A failing kick (bot
// lacking Kick Members, target left mid-action, rate limit) was swallowed with
// zero observability — the closest analog to the guarded model-driven kick in
// ai/executors/moderationExecutor.js. The fix keeps the call non-throwing but
// now logs the failure with member + guild context in the [Raid] style.
//
// This test drives execute() through the raid branch (trackJoin → true) with a
// rejecting member.kick and asserts: (1) execute() does not throw, and (2) the
// failure is logged rather than silently dropped.

const { logSpy, trackJoinSpy } = vi.hoisted(() => ({
  logSpy: vi.fn(),
  trackJoinSpy: vi.fn(() => true), // force the raid branch
}));

// ── Mock every module guildMemberAdd.execute() imports so the handler runs to
//    completion harmlessly and we can observe just the raid-kick branch. ──────
vi.mock("../../database.js", () => ({
  getGuildSettings: vi.fn(() => ({})),
  setAutorole: vi.fn(),
  setWelcomeChannel: vi.fn(),
  getDmWelcome: vi.fn(() => ({ enabled: false, message: "" })),
  getWelcomeEmbed: vi.fn(() => ({})),
  recordInviteJoin: vi.fn(),
  getGhostPingChannels: vi.fn(() => []),
  isDmOptout: vi.fn(() => false),
}));

vi.mock("../../utils/embeds.js", () => ({
  logEmbed: vi.fn(() => ({})),
  LC: {},
  logEvent: vi.fn(() => ({})),
}));

vi.mock("../../utils/logger.js", () => ({
  log: (...args: unknown[]) => logSpy(...args),
  sendModLog: vi.fn(async () => {}),
}));

vi.mock("../../utils/safety.js", () => ({
  trackJoin: () => trackJoinSpy(),
  activateLockdown: vi.fn(async () => {}),
  checkNewAccount: vi.fn(async () => {}),
}));

vi.mock("../../utils/invites.js", () => ({
  findUsedInvite: vi.fn(async () => null),
  refreshInvites: vi.fn(async () => {}),
}));

vi.mock("../../utils/stats.js", () => ({
  updateStatsChannels: vi.fn(async () => {}),
}));

vi.mock("../../utils/raid.js", () => ({
  checkRaid: vi.fn(() => {}),
}));

// Dynamic imports inside execute() — keep them harmless.
vi.mock("../../ai/executor.js", () => ({
  invalidateMemberIndex: vi.fn(),
}));

vi.mock("../../ai/bumpCorrelation.js", () => ({
  recordJoinForCorrelation: vi.fn(async () => {}),
}));

// @ts-expect-error - importing JS module without types
import { buildWelcomeEmbed, execute } from "../../events/guildMemberAdd.js";

function makeMember(kickImpl: () => Promise<unknown>) {
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    memberCount: 50,
    iconURL: () => null,
    bannerURL: () => null,
    members: { cache: { filter: () => ({ size: 1 }) }, me: null },
    channels: { cache: { find: () => null, get: () => null }, fetch: async () => null },
    roles: { cache: { get: () => null } },
  };
  return {
    id: "member-1",
    joinedTimestamp: Date.now(),
    user: {
      id: "member-1",
      bot: false,
      tag: "Raider#0001",
      username: "Raider",
      createdTimestamp: Date.now() - 86_400_000,
      displayAvatarURL: () => null,
    },
    displayName: "Raider",
    toString: () => "<@member-1>",
    guild,
    kick: vi.fn(kickImpl),
    roles: { add: vi.fn(async () => {}) },
    send: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  logSpy.mockClear();
  trackJoinSpy.mockClear();
  trackJoinSpy.mockReturnValue(true);
});

describe("guildMemberAdd raid auto-kick resilience", () => {
  it("renders default welcome embed text with a username, leaving the real ping in message content", () => {
    const member = makeMember(async () => {});

    const { embed, pingContent } = buildWelcomeEmbed(member as any, {}, {});

    expect(embed.data.title).toBe("👋 Welcome, Raider!");
    expect(embed.data.description).toContain("Everyone say hello to Raider!");
    expect(embed.data.title).not.toContain("<@member-1>");
    expect(embed.data.description).not.toContain("<@member-1>");
    expect(pingContent).toContain("<@member-1>");
  });

  it("supports {mention} for explicit custom welcome mentions", () => {
    const member = makeMember(async () => {});

    const { embed } = buildWelcomeEmbed(
      member as any,
      { welcome_message: "actual mention: {mention}; display: {user}" },
      {},
    );

    expect(embed.data.description).toContain("actual mention: <@member-1>");
    expect(embed.data.description).toContain("display: Raider");
  });

  it("logs (does not silently swallow) a failing raid kick and does not throw", async () => {
    const member = makeMember(async () => {
      throw new Error("Missing Permissions");
    });

    await expect(execute(member as any)).resolves.toBeUndefined();

    expect(member.kick).toHaveBeenCalledWith("Auto-mod: raid detected");
    const raidKickLog = logSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("[Raid] Auto-kick failed"),
    );
    expect(raidKickLog, "expected a [Raid] Auto-kick failed log line").toBeTruthy();
    expect(raidKickLog?.[0]).toContain("member-1");
    expect(raidKickLog?.[0]).toContain("guild-1");
    expect(raidKickLog?.[0]).toContain("Missing Permissions");
  });

  it("does not log a kick failure when the kick succeeds", async () => {
    const member = makeMember(async () => {});

    await expect(execute(member as any)).resolves.toBeUndefined();

    expect(member.kick).toHaveBeenCalledWith("Auto-mod: raid detected");
    const raidKickLog = logSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("[Raid] Auto-kick failed"),
    );
    expect(raidKickLog).toBeUndefined();
  });
});
