// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  setLogChannel: vi.fn(),
  getTrustedUsers: vi.fn(() => []),
}));

import { setLogChannel } from "../../../database.js";
import { execute, data } from "../../../commands/setup/logging.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeChannel,
  repliedText,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => vi.clearAllMocks());

describe("/logging", () => {
  it("declares the logging command", () => {
    expect(data.name).toBe("logging");
  });

  it("blocks a member with no relevant permissions (not admin/manage-guild/owner)", async () => {
    const channel = makeChannel({ name: "logs" });
    const interaction = makeInteraction({
      options: { channel },
      permissions: [PermissionFlagsBits.SendMessages], // ordinary member
    });

    await execute(interaction);

    expect(setLogChannel).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });

  it("sets the log channel for an admin", async () => {
    const channel = makeChannel({ name: "mod-log" });
    const interaction = makeInteraction({
      options: { channel },
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(setLogChannel).toHaveBeenCalledWith(interaction.guild.id, channel.id);
    expect(repliedText(interaction)).toMatch(/Log Channel Set/i);
    expect(repliedText(interaction)).toContain(`<#${channel.id}>`);
  });

  it("also allows a Manage Server member (isAdminOrOwner accepts ManageGuild)", async () => {
    const channel = makeChannel({ name: "audit" });
    const interaction = makeInteraction({
      options: { channel },
      permissions: [PermissionFlagsBits.ManageGuild],
    });

    await execute(interaction);

    expect(setLogChannel).toHaveBeenCalledWith(interaction.guild.id, channel.id);
    expect(repliedText(interaction)).toMatch(/Log Channel Set/i);
  });
});
