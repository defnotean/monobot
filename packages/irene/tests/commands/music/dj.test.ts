import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error JS helper without types
import { makeInteraction, makeRole, makeUser, makeMember, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as dj from "../../../commands/music/dj.js";

beforeEach(() => {
  vi.clearAllMocks();
  // dj.js keeps an in-memory store; clear any role left over from a prior test.
  dj.removeDjRole("g-test");
});

describe("/dj store helpers", () => {
  it("set/get/remove round-trip and requireDj is open when no role is set", async () => {
    expect(dj.getDjRole("g-test")).toBeNull();
    dj.setDjRole("g-test", "role-1");
    expect(dj.getDjRole("g-test")).toBe("role-1");
    dj.removeDjRole("g-test");
    expect(dj.getDjRole("g-test")).toBeNull();
  });

  it("getDjData / initDjData serialize and restore the store", () => {
    dj.setDjRole("g-a", "r-a");
    dj.setDjRole("g-b", "r-b");
    const snapshot = dj.getDjData();
    expect(snapshot).toMatchObject({ "g-a": "r-a", "g-b": "r-b" });
    dj.removeDjRole("g-a");
    dj.removeDjRole("g-b");
    dj.initDjData({ dj: { "g-a": "r-a", "g-b": "r-b" } });
    expect(dj.getDjRole("g-a")).toBe("r-a");
    dj.removeDjRole("g-a");
    dj.removeDjRole("g-b");
  });
});

describe("/dj requireDj gate", () => {
  it("returns true when no DJ role is configured", async () => {
    const interaction = makeInteraction({});
    await expect(dj.requireDj(interaction)).resolves.toBe(true);
  });

  it("returns true for the server owner even when a DJ role is set", async () => {
    const interaction = makeInteraction({ isOwner: true });
    dj.setDjRole(interaction.guild.id, "dj-role");
    await expect(dj.requireDj(interaction)).resolves.toBe(true);
    dj.removeDjRole(interaction.guild.id);
  });

  it("returns true for a Manage Guild admin", async () => {
    const interaction = makeInteraction({ permissions: [PermissionFlagsBits.ManageGuild] });
    dj.setDjRole(interaction.guild.id, "dj-role");
    await expect(dj.requireDj(interaction)).resolves.toBe(true);
    dj.removeDjRole(interaction.guild.id);
  });

  it("returns true when the member holds the DJ role", async () => {
    const djRole = makeRole({ name: "DJs" });
    const interaction = makeInteraction({ permissions: [] });
    interaction.member.roles.cache.set(djRole.id, djRole);
    interaction.guild.roles.cache.set(djRole.id, djRole);
    dj.setDjRole(interaction.guild.id, djRole.id);
    await expect(dj.requireDj(interaction)).resolves.toBe(true);
    dj.removeDjRole(interaction.guild.id);
  });

  it("denies (and replies) when the member lacks the DJ role + perms + ownership", async () => {
    const djRole = makeRole({ name: "Crew" });
    const interaction = makeInteraction({ permissions: [] });
    interaction.guild.roles.cache.set(djRole.id, djRole);
    dj.setDjRole(interaction.guild.id, djRole.id);
    await expect(dj.requireDj(interaction)).resolves.toBe(false);
    expect(repliedText(interaction)).toMatch(/DJ Role Required/i);
    expect(repliedText(interaction)).toContain("Crew");
    dj.removeDjRole(interaction.guild.id);
  });
});

describe("/dj command", () => {
  it("set: blocks members without Manage Guild", async () => {
    const role = makeRole({ name: "DJs" });
    const interaction = makeInteraction({ subcommand: "set", options: { role }, permissions: [] });
    await dj.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Guild/i);
    expect(dj.getDjRole(interaction.guild.id)).toBeNull();
  });

  it("set: a Manage Guild member stores the DJ role", async () => {
    const role = makeRole({ name: "Music Crew" });
    const interaction = makeInteraction({
      subcommand: "set",
      options: { role },
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await dj.execute(interaction);
    expect(dj.getDjRole(interaction.guild.id)).toBe(role.id);
    expect(repliedText(interaction)).toMatch(/DJ Role Set/i);
    dj.removeDjRole(interaction.guild.id);
  });

  it("remove: blocks members without Manage Guild", async () => {
    const interaction = makeInteraction({ subcommand: "remove", permissions: [] });
    dj.setDjRole(interaction.guild.id, "rid");
    await dj.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Manage Guild/i);
    // role left intact because the gate blocked the removal
    expect(dj.getDjRole(interaction.guild.id)).toBe("rid");
    dj.removeDjRole(interaction.guild.id);
  });

  it("remove: a Manage Guild member clears the DJ role", async () => {
    const interaction = makeInteraction({ subcommand: "remove", permissions: [PermissionFlagsBits.ManageGuild] });
    dj.setDjRole(interaction.guild.id, "rid");
    await dj.execute(interaction);
    expect(dj.getDjRole(interaction.guild.id)).toBeNull();
    expect(repliedText(interaction)).toMatch(/DJ Role Removed/i);
  });

  it("status: reports no role set when none is configured (no perms needed)", async () => {
    const interaction = makeInteraction({ subcommand: "status", permissions: [] });
    await dj.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No DJ role is set/i);
  });

  it("status: shows the configured role name when one is set", async () => {
    const role = makeRole({ name: "Selectors" });
    const interaction = makeInteraction({ subcommand: "status", permissions: [] });
    interaction.guild.roles.cache.set(role.id, role);
    dj.setDjRole(interaction.guild.id, role.id);
    await dj.execute(interaction);
    expect(repliedText(interaction)).toContain("Selectors");
    dj.removeDjRole(interaction.guild.id);
  });

  it("check: reports DJ access for a user holding the role", async () => {
    const role = makeRole({ name: "DJs" });
    const target = makeUser({ username: "dancer" });
    const interaction = makeInteraction({ subcommand: "check", options: { user: target }, permissions: [] });
    const targetMember = makeMember({ user: target, guild: interaction.guild, permissions: [] });
    targetMember.roles.cache.set(role.id, role);
    interaction.guild.members.cache.set(target.id, targetMember);
    interaction.guild.roles.cache.set(role.id, role);
    dj.setDjRole(interaction.guild.id, role.id);

    await dj.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toMatch(/Has DJ Role/i);
    expect(text).toContain("dancer");
    dj.removeDjRole(interaction.guild.id);
  });

  it("check: reports no access when the target lacks the role/perms/ownership", async () => {
    const role = makeRole({ name: "DJs" });
    const target = makeUser({ username: "nobody" });
    const interaction = makeInteraction({ subcommand: "check", options: { user: target }, permissions: [] });
    const targetMember = makeMember({ user: target, guild: interaction.guild, permissions: [] });
    interaction.guild.members.cache.set(target.id, targetMember);
    interaction.guild.roles.cache.set(role.id, role);
    dj.setDjRole(interaction.guild.id, role.id);

    await dj.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No DJ access/i);
    dj.removeDjRole(interaction.guild.id);
  });

  it("check: reports a user not found when the member fetch fails", async () => {
    const target = makeUser({ username: "ghost" });
    const interaction = makeInteraction({ subcommand: "check", options: { user: target }, permissions: [] });
    // guild.members.fetch returns null for an uncached id by default
    await dj.execute(interaction);
    expect(repliedText(interaction)).toMatch(/User Not Found/i);
  });
});
