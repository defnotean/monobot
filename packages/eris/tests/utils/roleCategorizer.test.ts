// Council-round regression seeds for utils/roleCategorizer.js
// Priorities: cosmetic roles with role-name collisions MUST NOT be
// categorized as staff (that was the original concern that drove building
// the categorizer), and category-keyword resolution must handle common
// plural/casing variants.

import { describe, it, expect } from "vitest";
import {
  categorizeRole,
  getRolesByCategory,
  asCategoryKeyword,
  resolveRoleHints,
} from "../../utils/roleCategorizer.js";
import { PermissionFlagsBits as P } from "discord.js";

// ─── Test harness ─────────────────────────────────────────────────────────
// Discord.js PermissionsBitField exposes .has(perm). Mock only that surface.

type MockPerms = { has: (bit: bigint) => boolean };
function mkPerms(bits: bigint): MockPerms {
  return { has: (b) => (bits & b) !== 0n };
}

interface MockRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  permissions: MockPerms;
}

interface MockGuild {
  id: string;
  roles: { cache: Map<string, MockRole> };
}

// discord.js's Collection extends Map and adds .find(predicate). The
// categorizer uses .find(), so our test cache needs the same shape.
class CollectionLike<K, V> extends Map<K, V> {
  find(predicate: (value: V, key: K) => boolean): V | undefined {
    for (const [k, v] of this) if (predicate(v, k)) return v;
    return undefined;
  }
}

function mkGuild(roles: MockRole[]): MockGuild {
  const cache = new CollectionLike<string, MockRole>();
  for (const r of roles) cache.set(r.id, r);
  return { id: "guild-1", roles: { cache } };
}

// ─────────────────────────────────────────────────────────────────────────

describe("categorizeRole", () => {
  it("returns `everyone` for the @everyone role (role.id === guild.id)", () => {
    const guild = mkGuild([
      { id: "guild-1", name: "@everyone", position: 0, managed: false, permissions: mkPerms(0n) },
    ]);
    const role = guild.roles.cache.get("guild-1")!;
    expect(categorizeRole(role as any, guild as any)).toBe("everyone");
  });

  it("returns `bot` for a role.managed integration role (regardless of perms)", () => {
    const role: MockRole = {
      id: "r-bot", name: "Some Bot", position: 5, managed: true,
      permissions: mkPerms(P.Administrator as bigint),
    };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("bot");
  });

  it("returns `admin` for Administrator perm", () => {
    const role: MockRole = { id: "r-admin", name: "Admin", position: 10, managed: false, permissions: mkPerms(P.Administrator as bigint) };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("admin");
  });

  it("returns `admin` for ManageGuild perm (even without Administrator)", () => {
    const role: MockRole = { id: "r-mg", name: "Manager", position: 10, managed: false, permissions: mkPerms(P.ManageGuild as bigint) };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("admin");
  });

  it("returns `moderator` for BanMembers + KickMembers + ModerateMembers (no admin perms)", () => {
    const perms = (P.BanMembers as bigint) | (P.KickMembers as bigint) | (P.ModerateMembers as bigint);
    const role: MockRole = { id: "r-mod", name: "Staff Team", position: 8, managed: false, permissions: mkPerms(perms) };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("moderator");
  });

  it("returns `moderator` when ManageChannels OR ManageRoles is present", () => {
    for (const perm of [P.ManageChannels, P.ManageRoles]) {
      const role: MockRole = { id: "r-mod-" + perm, name: "X", position: 5, managed: false, permissions: mkPerms(perm as bigint) };
      const guild = mkGuild([role]);
      expect(categorizeRole(role as any, guild as any)).toBe("moderator");
    }
  });

  it("returns `helper` for ManageMessages only (no ban/kick/timeout)", () => {
    const role: MockRole = { id: "r-helper", name: "Content Helper", position: 5, managed: false, permissions: mkPerms(P.ManageMessages as bigint) };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("helper");
  });

  it("returns `cosmetic` for a role with zero permissions (THE aesthetic-role scenario)", () => {
    // This is the scenario that motivated the whole categorizer: someone
    // makes a role called "🎭 Moderator" for vanity, no perms attached.
    // If we categorized by name it would leak into the mod set.
    const role: MockRole = {
      id: "r-vanity", name: "🎭 Moderator",
      position: 3, managed: false, permissions: mkPerms(0n),
    };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("cosmetic");
  });

  it("returns `cosmetic` for color-only vanity roles regardless of name", () => {
    for (const name of ["Pink Vibes", "Admin", "Moderator", "Owner", "Staff"]) {
      const role: MockRole = { id: "r-" + name, name, position: 2, managed: false, permissions: mkPerms(0n) };
      const guild = mkGuild([role]);
      expect(categorizeRole(role as any, guild as any)).toBe("cosmetic");
    }
  });

  it("admin perm beats helper — a role with Administrator AND ManageMessages is `admin`", () => {
    const perms = (P.Administrator as bigint) | (P.ManageMessages as bigint);
    const role: MockRole = { id: "r-super", name: "Super", position: 10, managed: false, permissions: mkPerms(perms) };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("admin");
  });

  it("moderator perm beats helper — Ban + ManageMessages is `moderator`", () => {
    const perms = (P.BanMembers as bigint) | (P.ManageMessages as bigint);
    const role: MockRole = { id: "r-modstaff", name: "X", position: 5, managed: false, permissions: mkPerms(perms) };
    const guild = mkGuild([role]);
    expect(categorizeRole(role as any, guild as any)).toBe("moderator");
  });
});

describe("getRolesByCategory", () => {
  function buildMixedGuild() {
    return mkGuild([
      { id: "guild-1", name: "@everyone", position: 0, managed: false, permissions: mkPerms(0n) },
      { id: "r-bot", name: "Irene", position: 20, managed: true, permissions: mkPerms(P.Administrator as bigint) },
      { id: "r-admin", name: "Admin", position: 15, managed: false, permissions: mkPerms(P.Administrator as bigint) },
      { id: "r-mod", name: "Staff Team", position: 10, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
      { id: "r-helper", name: "Content Dev", position: 7, managed: false, permissions: mkPerms(P.ManageMessages as bigint) },
      { id: "r-vanity-mod", name: "🎭 Moderator", position: 5, managed: false, permissions: mkPerms(0n) },
      { id: "r-pink", name: "Pink Vibes", position: 3, managed: false, permissions: mkPerms(0n) },
    ]);
  }

  it("asking for `moderator` returns ONLY real-perm mods, NOT the vanity 'Moderator' role", () => {
    const guild = buildMixedGuild();
    const ids = getRolesByCategory(guild as any, "moderator").map((r) => r.id);
    expect(ids).toEqual(["r-mod"]);
    expect(ids).not.toContain("r-vanity-mod");
  });

  it("asking for `admin` returns only Administrator/ManageGuild holders, not the bot role", () => {
    const guild = buildMixedGuild();
    const ids = getRolesByCategory(guild as any, "admin").map((r) => r.id);
    expect(ids).toEqual(["r-admin"]);
  });

  it("meta-category `staff` returns admin ∪ moderator, sorted by position descending", () => {
    const guild = buildMixedGuild();
    const ids = getRolesByCategory(guild as any, "staff").map((r) => r.id);
    expect(ids).toEqual(["r-admin", "r-mod"]); // admin pos 15, mod pos 10
  });

  it("meta-category `trusted` returns admin ∪ moderator ∪ helper", () => {
    const guild = buildMixedGuild();
    const ids = getRolesByCategory(guild as any, "trusted").map((r) => r.id).sort();
    expect(ids).toEqual(["r-admin", "r-helper", "r-mod"].sort());
  });

  it("returns [] for unknown category", () => {
    const guild = buildMixedGuild();
    expect(getRolesByCategory(guild as any, "nonsense")).toEqual([]);
  });

  it("returns [] on missing guild / missing roles cache", () => {
    expect(getRolesByCategory(null as any, "moderator")).toEqual([]);
    expect(getRolesByCategory({} as any, "moderator")).toEqual([]);
  });
});

describe("asCategoryKeyword (plural/casing tolerance)", () => {
  it("matches singular and plural forms of each category", () => {
    expect(asCategoryKeyword("mod")).toBe("mod");
    expect(asCategoryKeyword("mods")).toBe("mods");
    expect(asCategoryKeyword("moderator")).toBe("moderator");
    expect(asCategoryKeyword("moderators")).toBe("moderators");
    expect(asCategoryKeyword("admin")).toBe("admin");
    expect(asCategoryKeyword("admins")).toBe("admins");
    expect(asCategoryKeyword("administrator")).toBe("administrator");
    expect(asCategoryKeyword("staff")).toBe("staff");
    expect(asCategoryKeyword("trusted")).toBe("trusted");
  });

  it("tolerates leading @ and case variations", () => {
    expect(asCategoryKeyword("@Mods")).toBe("mods");
    expect(asCategoryKeyword("STAFF")).toBe("staff");
    expect(asCategoryKeyword("  Admins ")).toBe("admins");
    expect(asCategoryKeyword("Any Staff")).toBe("any_staff");
  });

  it("returns null for non-keywords (arbitrary role names)", () => {
    expect(asCategoryKeyword("The Crew")).toBe(null);
    expect(asCategoryKeyword("pink vibes")).toBe(null);
    expect(asCategoryKeyword("")).toBe(null);
    expect(asCategoryKeyword(null as any)).toBe(null);
  });
});

describe("resolveRoleHints (ID → exact-name → category)", () => {
  it("resolves a raw role ID", () => {
    const guild = mkGuild([
      { id: "r-123", name: "Staff Team", position: 5, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
    ]);
    const roles = resolveRoleHints(guild as any, ["r-123"]);
    expect(roles.map((r) => r.id)).toEqual(["r-123"]);
  });

  it("resolves by exact case-insensitive role name", () => {
    const guild = mkGuild([
      { id: "r-1", name: "Staff Team", position: 5, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
    ]);
    expect(resolveRoleHints(guild as any, ["staff team"]).map((r) => r.id)).toEqual(["r-1"]);
    expect(resolveRoleHints(guild as any, ["Staff Team"]).map((r) => r.id)).toEqual(["r-1"]);
    expect(resolveRoleHints(guild as any, ["STAFF TEAM"]).map((r) => r.id)).toEqual(["r-1"]);
  });

  it("falls back to category keyword when name isn't found", () => {
    const guild = mkGuild([
      { id: "r-admin", name: "Server Admin", position: 10, managed: false, permissions: mkPerms(P.Administrator as bigint) },
      { id: "r-mod",   name: "The Crew",    position: 5, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
    ]);
    // "mods" isn't the name of any role, so category lookup kicks in.
    const roles = resolveRoleHints(guild as any, ["mods"]);
    expect(roles.map((r) => r.id)).toEqual(["r-mod"]);
  });

  it("expands comma-separated strings inside the array", () => {
    const guild = mkGuild([
      { id: "r-a", name: "Mods", position: 5, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
      { id: "r-b", name: "Admins", position: 10, managed: false, permissions: mkPerms(P.Administrator as bigint) },
    ]);
    const ids = resolveRoleHints(guild as any, ["Mods, Admins"]).map((r) => r.id).sort();
    expect(ids).toEqual(["r-a", "r-b"]);
  });

  it("dedupes when the same role matches multiple hints", () => {
    const guild = mkGuild([
      { id: "r-mod", name: "Staff Team", position: 5, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
    ]);
    const roles = resolveRoleHints(guild as any, ["r-mod", "Staff Team", "mods"]);
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe("r-mod");
  });

  it("returns [] when nothing matches", () => {
    const guild = mkGuild([
      { id: "r-a", name: "Something", position: 1, managed: false, permissions: mkPerms(0n) },
    ]);
    expect(resolveRoleHints(guild as any, ["nonexistent"])).toEqual([]);
    expect(resolveRoleHints(guild as any, [])).toEqual([]);
  });

  it("does NOT match the vanity 'Moderator' role when given category keyword 'mods'", () => {
    // Regression test for the original cosmetic-spoof concern.
    const guild = mkGuild([
      { id: "r-real", name: "The Crew",     position: 10, managed: false, permissions: mkPerms(P.BanMembers as bigint) },
      { id: "r-fake", name: "🎭 Moderator", position: 5,  managed: false, permissions: mkPerms(0n) }, // 0 perms, cosmetic
    ]);
    const ids = resolveRoleHints(guild as any, ["mods"]).map((r) => r.id);
    expect(ids).toContain("r-real");
    expect(ids).not.toContain("r-fake");
  });
});
