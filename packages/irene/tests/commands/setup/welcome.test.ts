// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  setWelcomeChannel: vi.fn(),
  getTrustedUsers: vi.fn(() => []),
}));

import { setWelcomeChannel } from "../../../database.js";
import { execute, data } from "../../../commands/setup/welcome.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeChannel,
  makeUser,
  makeGuild,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => vi.clearAllMocks());

describe("/welcome", () => {
  it("declares the welcome command with channel + message options", () => {
    expect(data.name).toBe("welcome");
  });

  it("blocks non-admin/non-owner", async () => {
    const channel = makeChannel();
    const interaction = makeInteraction({
      options: { channel, message: "hi" },
      permissions: [],
    });

    await execute(interaction);

    expect(setWelcomeChannel).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });

  it("persists channel + message and renders a substituted preview", async () => {
    const channel = makeChannel({ name: "welcome" });
    const user = makeUser({ username: "alice" });
    const guild = makeGuild({ name: "CoolServer", ownerId: user.id });
    guild.memberCount = 42;
    const interaction = makeInteraction({
      user,
      guild,
      isOwner: true,
      options: {
        channel,
        message: "Welcome {user} to {server}! #{membercount} ({username})",
      },
    });

    await execute(interaction);

    expect(setWelcomeChannel).toHaveBeenCalledWith(
      guild.id,
      channel.id,
      "Welcome {user} to {server}! #{membercount} ({username})",
    );
    const text = repliedText(interaction);
    // Placeholders must be replaced in the preview.
    expect(text).toContain(`<@${user.id}>`); // {user}
    expect(text).toContain("CoolServer"); // {server}
    expect(text).toContain("42"); // {membercount}
    expect(text).toContain("alice"); // {username}
    expect(text).not.toContain("{membercount}");
  });

  it("uses the default preview text when no message is given", async () => {
    const channel = makeChannel();
    const interaction = makeInteraction({
      options: { channel }, // message omitted -> null
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(setWelcomeChannel).toHaveBeenCalledWith(interaction.guild.id, channel.id, null);
    // default template references being a member
    expect(repliedText(interaction)).toMatch(/glad you're here/i);
  });

  it("rejects a whitespace-only message before persisting", async () => {
    const channel = makeChannel();
    const interaction = makeInteraction({
      options: { channel, message: "   " },
      permissions: [PermissionFlagsBits.Administrator],
    });

    await execute(interaction);

    expect(setWelcomeChannel).not.toHaveBeenCalled();
    const last = lastReply(interaction);
    expect(last.content).toMatch(/can't be empty/i);
    expect(last.flags).toBe(64);
  });
});
