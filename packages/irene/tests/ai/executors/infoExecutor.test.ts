// ─── infoExecutor — read-only server/member introspection + DM preference ────
//
// These handlers are CACHEABLE pure reads, so the contract is "stable output
// for the same input". Tests cover the formatting branches (server info, user
// info, role permissions granted/denied split, who-has-role), the not-found
// paths for unknown users/roles, and the per-user DM-preference toggle's
// authorization gate (you can only change your OWN preference unless admin).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, ChannelType } from "discord.js";

vi.mock("../../../database.js", () => ({
  setDmOptout: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/infoExecutor.js";
// @ts-expect-error - importing JS module without types
import { setDmOptout } from "../../../database.js";

function fakeCollection<T>(items: T[]) {
  const arr = [...items];
  return {
    size: arr.length,
    filter(fn: (x: T) => boolean) { return fakeCollection(arr.filter(fn)); },
    sort(fn: (a: T, b: T) => number) { return fakeCollection([...arr].sort(fn)); },
    map<U>(fn: (x: T) => U) { return arr.map(fn); },
    values() { return arr.values(); },
    has(id: string) { return arr.some((x: any) => x.id === id); },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("infoExecutor — routing", () => {
  it("returns undefined for an unhandled tool", async () => {
    const r = await execute("not_an_info_tool", {}, { author: { id: "u" } }, { guild: {} });
    expect(r).toBeUndefined();
  });
});

describe("get_server_info", () => {
  it("formats core server stats including the fetched owner tag", async () => {
    const guild = {
      name: "My Server",
      memberCount: 123,
      channels: { cache: { size: 10 } },
      roles: { cache: { size: 5 } },
      emojis: { cache: { size: 7 } },
      premiumTier: 2,
      premiumSubscriptionCount: 14,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      fetchOwner: vi.fn(async () => ({ user: { tag: "boss#0001" } })),
    };
    const r = await execute("get_server_info", {}, { author: { id: "u" } }, { guild });
    expect(String(r)).toContain("My Server");
    expect(String(r)).toContain("Members: 123");
    expect(String(r)).toContain("Owner: boss#0001");
    expect(String(r)).toContain("Level 2");
  });
});

describe("get_user_info", () => {
  it("reports not-found for an unknown user", async () => {
    const ctx = { guild: { id: "g" }, findMember: vi.fn(() => null) };
    const r = await execute("get_user_info", { username: "ghost" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toMatch(/couldn't find user "ghost"/i);
  });

  it("formats a member's roles, dates, and bot flag", async () => {
    const member = {
      user: { tag: "alice#0001", createdAt: new Date("2019-05-05"), bot: false },
      nickname: "Ali",
      joinedAt: new Date("2021-06-06"),
      // The @everyone role shares the guild id and is filtered out by the handler.
      roles: { cache: fakeCollection([{ id: "g", name: "@everyone" }, { id: "r1", name: "Member" }]) },
    };
    const ctx = { guild: { id: "g" }, findMember: vi.fn(() => member) };
    const r = await execute("get_user_info", { username: "alice" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toContain("alice#0001");
    expect(String(r)).toContain("Nickname: Ali");
    expect(String(r)).toContain("Roles: Member");
    expect(String(r)).toContain("Bot: No");
  });
});

describe("set_dm_preference", () => {
  it("toggles the caller's own preference (opt-out) without needing admin", async () => {
    const ctx = { guild: { ownerId: "owner" }, findMember: vi.fn() };
    const msg = { author: { id: "caller", username: "caller" }, member: { id: "caller", permissions: { has: () => false } } };
    const r = await execute("set_dm_preference", { allow_dms: false }, msg, ctx);
    expect(setDmOptout).toHaveBeenCalledWith("caller", true); // opt-out = !allow_dms
    expect(String(r)).toMatch(/won't DM you/i);
  });

  it("lets allow_dms:true clear the opt-out for the caller", async () => {
    const ctx = { guild: { ownerId: "owner" }, findMember: vi.fn() };
    const msg = { author: { id: "caller", username: "caller" }, member: { id: "caller", permissions: { has: () => false } } };
    const r = await execute("set_dm_preference", { allow_dms: true }, msg, ctx);
    expect(setDmOptout).toHaveBeenCalledWith("caller", false);
    expect(String(r)).toMatch(/DM you again/i);
  });

  it("blocks a non-admin from changing ANOTHER user's DM preference", async () => {
    const target = { id: "target", user: { username: "target" } };
    const ctx = { guild: { ownerId: "owner" }, findMember: vi.fn(() => target) };
    const msg = {
      author: { id: "caller", username: "caller" },
      member: { id: "caller", permissions: { has: () => false } },
    };
    const r = await execute("set_dm_preference", { username: "target", allow_dms: false }, msg, ctx);
    expect(String(r)).toMatch(/only change your own/i);
    expect(setDmOptout).not.toHaveBeenCalled();
  });

  it("lets an admin change another user's DM preference", async () => {
    const target = { id: "target", user: { username: "target" } };
    const ctx = { guild: { ownerId: "owner" }, findMember: vi.fn(() => target) };
    const msg = {
      author: { id: "caller", username: "caller" },
      member: {
        id: "caller",
        permissions: { has: (p: bigint) => p === PermissionFlagsBits.Administrator },
      },
    };
    const r = await execute("set_dm_preference", { username: "target", allow_dms: false }, msg, ctx);
    expect(setDmOptout).toHaveBeenCalledWith("target", true);
    expect(String(r)).toMatch(/won't DM target/i);
  });

  it("reports not-found when the named user can't be resolved", async () => {
    const ctx = { guild: { ownerId: "owner" }, findMember: vi.fn(() => null) };
    const msg = { author: { id: "caller", username: "caller" }, member: { id: "caller", permissions: { has: () => false } } };
    const r = await execute("set_dm_preference", { username: "ghost", allow_dms: true }, msg, ctx);
    expect(String(r)).toMatch(/couldn't find user "ghost"/i);
    expect(setDmOptout).not.toHaveBeenCalled();
  });
});

describe("get_role_permissions", () => {
  it("reports not-found for an unknown role", async () => {
    const ctx = { guild: { id: "g" }, findRole: vi.fn(() => null) };
    const r = await execute("get_role_permissions", { role_name: "ghost" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toMatch(/couldn't find role "ghost"/i);
  });

  it("splits permissions into granted vs denied lists", async () => {
    const role = {
      name: "Mods",
      position: 5,
      color: 0xff0000,
      members: { size: 3 },
      permissions: { has: (flag: bigint) => flag === PermissionFlagsBits.KickMembers || flag === PermissionFlagsBits.BanMembers },
    };
    const ctx = { guild: { id: "g" }, findRole: vi.fn(() => role) };
    const r = await execute("get_role_permissions", { role_name: "Mods" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toContain("@Mods");
    expect(String(r)).toMatch(/Granted:.*Kick Members/);
    expect(String(r)).toMatch(/Granted:.*Ban Members/);
    expect(String(r)).toMatch(/Denied:.*Administrator/);
  });
});

describe("who_has_role", () => {
  it("reports not-found for an unknown role", async () => {
    const ctx = { guild: {}, findRole: vi.fn(() => null) };
    const r = await execute("who_has_role", { role_name: "ghost" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toMatch(/couldn't find role/i);
  });

  it("says no one has the role when empty (bots excluded)", async () => {
    const role = { name: "VIP", members: fakeCollection([{ user: { bot: true, tag: "Bot#0000" } }]) };
    const ctx = { guild: {}, findRole: vi.fn(() => role) };
    const r = await execute("who_has_role", { role_name: "VIP" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toMatch(/No one has the "VIP" role/i);
  });

  it("lists members holding the role", async () => {
    const role = {
      name: "VIP",
      members: fakeCollection([
        { user: { bot: false, tag: "alice#0001" } },
        { user: { bot: false, tag: "bob#0002" } },
        { user: { bot: true, tag: "Bot#0000" } },
      ]),
    };
    const ctx = { guild: {}, findRole: vi.fn(() => role) };
    const r = await execute("who_has_role", { role_name: "VIP" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toContain("alice#0001");
    expect(String(r)).toContain("bob#0002");
    expect(String(r)).not.toContain("Bot#0000");
    expect(String(r)).toMatch(/2 members/);
  });
});

describe("list_roles", () => {
  it("lists non-@everyone roles with a count prefix", async () => {
    const guild = {
      id: "g",
      roles: { cache: fakeCollection([
        { id: "g", name: "@everyone", position: 0, unicodeEmoji: null, icon: null },
        { id: "r1", name: "Admin", position: 3, unicodeEmoji: null, icon: null },
        { id: "r2", name: "Member", position: 1, unicodeEmoji: null, icon: null },
      ]) },
    };
    const r = await execute("list_roles", {}, { author: { id: "u" } }, { guild });
    expect(String(r)).toContain("2 roles:");
    expect(String(r)).toContain("Admin");
    expect(String(r)).toContain("Member");
    expect(String(r)).not.toContain("@everyone");
  });
});

describe("list_channels", () => {
  it("returns 'No channels' for an empty guild", async () => {
    const guild = { channels: { cache: fakeCollection([]) } };
    const r = await execute("list_channels", {}, { author: { id: "u" } }, { guild });
    expect(String(r)).toBe("No channels");
  });

  it("groups channels under their category and lists orphans", async () => {
    const channels = [
      { id: "cat1", name: "General", type: ChannelType.GuildCategory, position: 0, parentId: null },
      { id: "txt1", name: "chat", type: ChannelType.GuildText, position: 0, parentId: "cat1" },
      { id: "vc1", name: "Voice", type: ChannelType.GuildVoice, position: 1, parentId: "cat1" },
      { id: "orph", name: "loose", type: ChannelType.GuildText, position: 0, parentId: null },
    ];
    const guild = { channels: { cache: fakeCollection(channels) } };
    const r = await execute("list_channels", {}, { author: { id: "u" } }, { guild });
    expect(String(r)).toContain("📁 General");
    expect(String(r)).toContain("# chat");
    expect(String(r)).toContain("🔊 Voice");
    expect(String(r)).toContain("# loose");
  });
});

describe("list_bans", () => {
  it("reports no bans when the list is empty", async () => {
    const guild = { bans: { fetch: vi.fn(async () => ({ size: 0 })) } };
    const r = await execute("list_bans", {}, { author: { id: "u" } }, { guild });
    expect(String(r)).toMatch(/No banned users/i);
  });

  it("formats each ban with its reason", async () => {
    const bans = fakeCollection([
      { user: { tag: "bad#0001" }, reason: "spam" },
      { user: { tag: "evil#0002" }, reason: null },
    ]);
    const guild = { bans: { fetch: vi.fn(async () => bans) } };
    const r = await execute("list_bans", {}, { author: { id: "u" } }, { guild });
    expect(String(r)).toContain("bad#0001 — spam");
    expect(String(r)).toContain("evil#0002 — No reason");
  });
});

describe("count_members", () => {
  it("counts non-bot members and applies a role filter", async () => {
    const members = fakeCollection([
      { user: { bot: false }, roles: { cache: { has: (id: string) => id === "r1" } }, presence: { status: "online" } },
      { user: { bot: false }, roles: { cache: { has: () => false } }, presence: { status: "idle" } },
      { user: { bot: true }, roles: { cache: { has: () => true } }, presence: null },
    ]);
    const role = { id: "r1" };
    const guild = { members: { fetch: vi.fn(async () => {}), cache: members } };
    const ctx = { guild, findRole: vi.fn(() => role) };
    const r = await execute("count_members", { role_name: "Special" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toMatch(/1 members with "Special"/);
  });

  it("reports not-found when the role filter can't be resolved", async () => {
    const guild = { members: { fetch: vi.fn(async () => {}), cache: fakeCollection([]) } };
    const ctx = { guild, findRole: vi.fn(() => null) };
    const r = await execute("count_members", { role_name: "ghost" }, { author: { id: "u" } }, ctx);
    expect(String(r)).toMatch(/couldn't find role/i);
  });
});
