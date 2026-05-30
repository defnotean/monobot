// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module the command writes to so we can assert the effect.
vi.mock("../../../database.js", () => ({
  setAutorole: vi.fn(),
  getCustomCommand: vi.fn(),
  setCustomCommand: vi.fn(),
  deleteCustomCommand: vi.fn(),
  listCustomCommands: vi.fn(() => []),
  // requireAdminOrOwner -> isAdminOrOwner reads the trusted-user whitelist.
  getTrustedUsers: vi.fn(() => []),
}));

import { setAutorole } from "../../../database.js";
import { execute, data } from "../../../commands/setup/autorole.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makePermissions,
  makeRole,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => vi.clearAllMocks());

describe("/autorole", () => {
  it("exposes the expected command metadata", () => {
    expect(data.name).toBe("autorole");
  });

  it("refuses a non-admin, non-owner member and does NOT persist", async () => {
    const role = makeRole({ name: "Members" });
    const interaction = makeInteraction({
      options: { role },
      permissions: [], // no perms
    });

    await execute(interaction);

    // requireAdminOrOwner replies with an error and returns false
    expect(setAutorole).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });

  it("allows an Administrator and persists the role id", async () => {
    const role = makeRole({ name: "Newbies", position: 0 });
    const interaction = makeInteraction({
      options: { role },
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(setAutorole).toHaveBeenCalledTimes(1);
    expect(setAutorole).toHaveBeenCalledWith(interaction.guild.id, role.id);
    expect(repliedText(interaction)).toMatch(/Auto-Role Set/i);
    // The success embed mentions the role via toString()
    expect(repliedText(interaction)).toContain(`<@&${role.id}>`);
  });

  it("allows the guild owner even without explicit perms", async () => {
    const role = makeRole({ position: 0 });
    const interaction = makeInteraction({
      options: { role },
      isOwner: true,
      permissions: [],
    });

    await execute(interaction);

    expect(setAutorole).toHaveBeenCalledWith(interaction.guild.id, role.id);
    const last = lastReply(interaction);
    expect(last.embeds).toBeTruthy();
  });

  it("refuses to persist a role with dangerous permissions", async () => {
    const role = makeRole({
      name: "Admin",
      position: 0,
      permissions: makePermissions([PermissionFlagsBits.Administrator]),
    });
    const interaction = makeInteraction({
      options: { role },
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(setAutorole).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Unsafe Auto-Role/i);
    expect(repliedText(interaction)).toMatch(/elevated permissions/i);
  });

  it("refuses to persist a role at or above the bot's top role", async () => {
    const role = makeRole({ name: "Protected", position: 50, permissions: makePermissions([]) });
    const interaction = makeInteraction({
      options: { role },
      permissions: [PermissionFlagsBits.Administrator],
    });
    interaction.guild.members.me.roles.highest.position = 50;

    await execute(interaction);

    expect(setAutorole).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/above my top role/i);
  });
});
