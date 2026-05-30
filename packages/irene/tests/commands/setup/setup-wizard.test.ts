// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";

const dbState = { settings: {} };

vi.mock("../../../database.js", () => ({
  getGuildSettings: vi.fn(() => dbState.settings),
  setLogChannel: vi.fn(),
  setWelcomeChannel: vi.fn(),
  setGuildSetting: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  getGuildSettings,
  setLogChannel,
  setWelcomeChannel,
  setGuildSetting,
} from "../../../database.js";
import { execute, handleSetupWizard, data } from "../../../commands/setup/setup-wizard.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeGuild,
  makeChannel,
  makeRole,
  repliedText,
  lastReply,
  getReplies,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => {
  vi.clearAllMocks();
  dbState.settings = {};
});

// Give a channel a permissionsFor() that the bot passes by default.
function withBotPerms(ch, granted = true) {
  ch.permissionsFor = vi.fn(() => ({ has: () => granted }));
  return ch;
}

describe("/setup command (execute)", () => {
  it("declares the setup command", () => {
    expect(data.name).toBe("setup");
  });

  it("rejects when used outside a guild (DM)", async () => {
    const interaction = makeInteraction({ permissions: [PermissionFlagsBits.ManageGuild] });
    interaction.guild = null;
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/only be used in a server/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("rejects a member lacking Manage Server", async () => {
    const interaction = makeInteraction({ permissions: [] });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/Need Manage Server/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("renders the home menu for a Manage Server member", async () => {
    const interaction = makeInteraction({ permissions: [PermissionFlagsBits.ManageGuild] });
    await execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    const text = repliedText(interaction);
    expect(text).toMatch(/Setup Wizard/i);
    expect(text).toMatch(/Welcome messages/i);
    // editReply payload carries component rows of buttons
    const last = lastReply(interaction);
    expect(Array.isArray(last.components)).toBe(true);
    expect(last.components.length).toBeGreaterThan(0);
  });
});

describe("setup wizard handler (handleSetupWizard)", () => {
  it("refuses a non-admin", async () => {
    const interaction = makeInteraction({ customId: "setupwiz:home", permissions: [] });
    await handleSetupWizard(interaction);
    expect(repliedText(interaction)).toMatch(/only admins/i);
  });

  it("ignores customIds not in the setupwiz namespace", async () => {
    const interaction = makeInteraction({
      customId: "other:home",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    const result = await handleSetupWizard(interaction);
    expect(result).toBeUndefined();
    expect(getReplies(interaction)).toHaveLength(0);
  });

  it("navigates to a category page via update", async () => {
    const interaction = makeInteraction({
      customId: "setupwiz:welcome",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await handleSetupWizard(interaction);
    expect(interaction.update).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Welcome Messages/i);
  });

  it("welcome:pick rejects a channel the bot can't access", async () => {
    const guild = makeGuild();
    const ch = withBotPerms(makeChannel({ name: "welcome", guild }), false);
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:welcome:pick",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    interaction.channels = { first: () => ch };
    await handleSetupWizard(interaction);
    expect(setWelcomeChannel).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/View Channel/i);
  });

  it("welcome:pick saves the channel when bot perms pass", async () => {
    const guild = makeGuild();
    const ch = withBotPerms(makeChannel({ name: "welcome", guild }), true);
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:welcome:pick",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    interaction.channels = { first: () => ch };
    await handleSetupWizard(interaction);
    expect(setWelcomeChannel).toHaveBeenCalledWith(guild.id, ch.id, null);
    expect(interaction.update).toHaveBeenCalled();
  });

  it("modlog:pick persists via setLogChannel", async () => {
    const guild = makeGuild();
    const ch = withBotPerms(makeChannel({ name: "mod-log", guild }), true);
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:modlog:pick",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    interaction.channels = { first: () => ch };
    await handleSetupWizard(interaction);
    expect(setLogChannel).toHaveBeenCalledWith(guild.id, ch.id);
  });

  it("autorole:pick rejects a managed role", async () => {
    const guild = makeGuild();
    const role = makeRole({ name: "Bot Role", position: 1, managed: true });
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:autorole:pick",
      permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles],
    });
    interaction.member.roles.highest.position = 50;
    interaction.roles = { first: () => role };
    await handleSetupWizard(interaction);
    expect(setGuildSetting).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/managed by an integration/i);
  });

  it("autorole:pick rejects a role above the bot's top role", async () => {
    const guild = makeGuild();
    guild.members.me.roles.highest.position = 5;
    const role = makeRole({ name: "Above", position: 10 });
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:autorole:pick",
      permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles],
    });
    interaction.member.roles.highest.position = 50;
    interaction.roles = { first: () => role };
    await handleSetupWizard(interaction);
    expect(setGuildSetting).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/above my top role/i);
  });

  it("autorole:pick saves a valid assignable role", async () => {
    const guild = makeGuild();
    guild.members.me.roles.highest.position = 100;
    const role = makeRole({ name: "New", position: 3 });
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:autorole:pick",
      permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles],
    });
    interaction.member.roles.highest.position = 50;
    interaction.roles = { first: () => role };
    await handleSetupWizard(interaction);
    expect(setGuildSetting).toHaveBeenCalledWith(guild.id, "autorole_id", role.id);
    expect(interaction.update).toHaveBeenCalled();
  });

  it("clear action writes a null setting for the page's key", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:starboard:clear",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await handleSetupWizard(interaction);
    expect(setGuildSetting).toHaveBeenCalledWith(guild.id, "starboard_channel", null);
  });

  it("automod toggle flips the stored boolean", async () => {
    dbState.settings = { antiraid_enabled: false };
    const guild = makeGuild();
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:automod:toggle:antiraid",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await handleSetupWizard(interaction);
    expect(setGuildSetting).toHaveBeenCalledWith(guild.id, "antiraid_enabled", true);
  });

  it("leveling toggle disables when currently enabled (default)", async () => {
    dbState.settings = {}; // leveling defaults to enabled
    const guild = makeGuild();
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:leveling:toggle",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await handleSetupWizard(interaction);
    expect(setGuildSetting).toHaveBeenCalledWith(guild.id, "leveling_enabled", false);
  });

  it("unknown page with an action falls back to home", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({
      guild,
      customId: "setupwiz:bogus:pick",
      permissions: [PermissionFlagsBits.ManageGuild],
    });
    await handleSetupWizard(interaction);
    expect(interaction.update).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Setup Wizard/i);
  });
});
