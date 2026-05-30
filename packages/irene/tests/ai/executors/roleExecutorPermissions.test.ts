import { describe, it, expect, vi } from "vitest";
import { Collection, PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/roleExecutor.js";
import { makeGuild, makeMember, makePermissions, makeRole, makeUser } from "../../_helpers/mockDiscord.js";

function roleFixture(overrides: any = {}) {
  return makeRole({
    id: overrides.id ?? "role-1",
    name: overrides.name ?? "Member",
    position: overrides.position ?? 2,
    permissions: makePermissions(overrides.permissions ?? []),
    setPermissions: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    ...overrides,
  });
}

function buildHarness({
  actorPermissions = [PermissionFlagsBits.ManageRoles],
  actorId = "actor",
  ownerId = "owner",
  actorTop = 10,
  botTop = 50,
  botPermissions = [PermissionFlagsBits.ManageRoles],
  roles = [],
  members = [],
}: any = {}) {
  const guild = makeGuild({ ownerId, roles, members, botPermissions, botHighestRolePosition: botTop });
  const actor = makeMember({
    user: makeUser({ id: actorId, username: "actor", tag: "actor#0001" }),
    guild,
    permissions: actorPermissions,
    highestRolePosition: actorTop,
  });
  guild.members.cache.set(actor.id, actor);

  const message = {
    member: actor,
    author: { id: actor.id, username: "actor", tag: "actor#0001" },
    guild,
  };

  const ctx = {
    guild,
    by: "by test",
    parseHexColor: vi.fn((color: string | undefined) => color ?? null),
    findRole: vi.fn((g: any, name: string) => g.roles.cache.find((r: any) => r.name.toLowerCase() === name.toLowerCase()) ?? null),
    findMember: vi.fn((g: any, username: string) => g.members.cache.find((m: any) => m.user.username === username || m.user.tag === username) ?? null),
    checkRoleAssignment: (moderator: any, target: any, role: any, g: any) => {
      if (target.id === g.ownerId) return "owner blocked";
      if (target.id !== moderator.id && target.roles.highest.position >= moderator.roles.highest.position) return "target hierarchy blocked";
      if (role.position >= moderator.roles.highest.position) return "role hierarchy blocked";
      return null;
    },
  };

  return { guild, actor, message, ctx };
}

describe("roleExecutor permission hardening", () => {
  it("requires ManageRoles for role mutations instead of accepting ManageGuild", async () => {
    const role = roleFixture();
    const { guild, message, ctx } = buildHarness({
      actorPermissions: [PermissionFlagsBits.ManageGuild],
      roles: [role],
    });

    const result = await execute("delete_role", { name: "Member" }, message, ctx);

    expect(result).toMatch(/manage roles/i);
    expect(role.delete).not.toHaveBeenCalled();
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it("blocks non-admin callers from granting dangerous role permissions", async () => {
    const role = roleFixture();
    const { message, ctx } = buildHarness({ roles: [role] });

    const result = await execute("set_role_permissions", { role_name: "Member", manage_roles: true }, message, ctx);

    expect(result).toMatch(/administrator/i);
    expect(role.setPermissions).not.toHaveBeenCalled();
  });

  it("allows only the guild owner to grant Administrator to a role", async () => {
    const role = roleFixture();
    const { message, ctx } = buildHarness({
      actorPermissions: [PermissionFlagsBits.Administrator],
      roles: [role],
    });

    const result = await execute("set_role_permissions", { role_name: "Member", administrator: true }, message, ctx);

    expect(result).toMatch(/only the server owner/i);
    expect(role.setPermissions).not.toHaveBeenCalled();
  });

  it("blocks creating roles at or above the caller hierarchy", async () => {
    const { guild, message, ctx } = buildHarness({ actorTop: 10 });

    const result = await execute("create_role", { name: "High", position: 10 }, message, ctx);

    expect(result).toMatch(/at or above your top role/i);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it("enforces caller hierarchy before editing role permissions", async () => {
    const role = roleFixture({ position: 12 });
    const { message, ctx } = buildHarness({ actorTop: 10, roles: [role] });

    const result = await execute("set_role_permissions", { role_name: "Member", send_messages: false }, message, ctx);

    expect(result).toMatch(/at or above your top role/i);
    expect(role.setPermissions).not.toHaveBeenCalled();
  });

  it("enforces bot hierarchy before deleting roles", async () => {
    const role = roleFixture({ position: 55 });
    const { message, ctx } = buildHarness({ actorTop: 80, botTop: 50, roles: [role] });

    const result = await execute("delete_role", { name: "Member" }, message, ctx);

    expect(result).toMatch(/at or above my top role/i);
    expect(role.delete).not.toHaveBeenCalled();
  });

  it("enforces new positions for role reorders", async () => {
    const role = roleFixture({ position: 2 });
    const { guild, message, ctx } = buildHarness({ actorTop: 10, botTop: 50, roles: [role] });
    guild.roles.setPositions = vi.fn(async () => {});

    const result = await execute("reorder_roles", { roles: [{ name: "Member", position: 10 }] }, message, ctx);

    expect(result).toMatch(/at or above your top role/i);
    expect(guild.roles.setPositions).not.toHaveBeenCalled();
  });

  it("applies assignment checks to every mass_role target", async () => {
    const role = roleFixture({ position: 2 });
    const allowed = makeMember({
      user: makeUser({ id: "allowed", username: "allowed", tag: "allowed#0001" }),
      permissions: [],
      highestRolePosition: 1,
    });
    const blocked = makeMember({
      user: makeUser({ id: "blocked", username: "blocked", tag: "blocked#0001" }),
      permissions: [],
      highestRolePosition: 12,
    });
    const members = new Collection([[allowed.id, allowed], [blocked.id, blocked]]);
    const { guild, message, ctx } = buildHarness({ actorTop: 10, roles: [role] });
    guild.members.cache = members;

    const result = await execute("mass_role", { role_name: "Member", action: "give" }, message, ctx);

    expect(result).toMatch(/to 1 members/i);
    expect(result).toMatch(/1 skipped/i);
    expect(allowed.roles.add).toHaveBeenCalledWith(role);
    expect(blocked.roles.add).not.toHaveBeenCalled();
  });
});
