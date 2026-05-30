// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";

// ── Mock the database layer. getTicketConfig returns a configurable object. ──
const dbState = { cfg: null };
function freshCfg(over = {}) {
  return {
    category_id: null,
    view_role_ids: [],
    ping_role_ids: [],
    view_auto_category: null,
    ping_auto_category: null,
    welcome_title: null,
    welcome_description: null,
    welcome_color: null,
    panel_channel_id: null,
    panel_message_id: null,
    panel_title: null,
    panel_description: null,
    panel_color: null,
    panel_button_label: null,
    panel_button_emoji: null,
    types: [],
    ...over,
  };
}

vi.mock("../../../database.js", () => ({
  getTicketConfig: vi.fn(() => dbState.cfg),
  setTicketCategory: vi.fn(),
  setTicketViewRoles: vi.fn(),
  setTicketPingRoles: vi.fn(),
  setTicketModRoles: vi.fn(),
  setTicketWelcome: vi.fn(),
  setTicketPanel: vi.fn(),
  setTicketPanelMessage: vi.fn(),
  setTicketPanelChannel: vi.fn(),
  setTicketAutoCategory: vi.fn(),
  resolveTicketRoles: vi.fn(async () => ({ view_role_ids: [], ping_role_ids: [] })),
}));

// roleCategorizer is dynamically imported by the auto-mods subcommand.
vi.mock("@defnotean/shared/roleCategorizer", () => ({
  getRolesByCategory: vi.fn(() => []),
}));

import {
  getTicketConfig,
  setTicketCategory,
  setTicketViewRoles,
  setTicketPingRoles,
  setTicketModRoles,
  setTicketWelcome,
  setTicketAutoCategory,
  resolveTicketRoles,
} from "../../../database.js";
import { getRolesByCategory } from "@defnotean/shared/roleCategorizer";
import { execute, handleTicketWizard, data } from "../../../commands/setup/ticket.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeGuild,
  makeRole,
  makeChannel,
  makeUser,
  repliedText,
  lastReply,
  getReplies,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => {
  vi.clearAllMocks();
  dbState.cfg = freshCfg();
});

describe("/ticket command metadata", () => {
  it("declares the ticket command", () => {
    expect(data.name).toBe("ticket");
  });
});

describe("/ticket admin gate", () => {
  it("config subcommand refused for non-admin", async () => {
    const interaction = makeInteraction({
      subcommand: "config",
      permissions: [],
    });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });

  it("category subcommand refused for non-admin and does not persist", async () => {
    const cat = makeChannel({ name: "Tickets", type: ChannelType.GuildCategory });
    const interaction = makeInteraction({
      subcommand: "category",
      options: { category: cat },
      permissions: [],
    });
    await execute(interaction);
    expect(setTicketCategory).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/No Permission/i);
  });
});

describe("/ticket category", () => {
  it("sets the category for an admin", async () => {
    const cat = makeChannel({ name: "Support", type: ChannelType.GuildCategory });
    const interaction = makeInteraction({
      subcommand: "category",
      options: { category: cat },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setTicketCategory).toHaveBeenCalledWith(interaction.guild.id, cat.id);
    expect(repliedText(interaction)).toMatch(/Category Updated/i);
  });
});

describe("/ticket view-role", () => {
  it("sets a view role when a role is given", async () => {
    const role = makeRole({ name: "Staff" });
    const interaction = makeInteraction({
      subcommand: "view-role",
      options: { role },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setTicketViewRoles).toHaveBeenCalledWith(interaction.guild.id, [role.id]);
    expect(repliedText(interaction)).toMatch(/View Role Set/i);
  });

  it("clears view roles when no role is given", async () => {
    const interaction = makeInteraction({
      subcommand: "view-role",
      options: {}, // role omitted -> null
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setTicketViewRoles).toHaveBeenCalledWith(interaction.guild.id, []);
    expect(repliedText(interaction)).toMatch(/View Roles Cleared/i);
  });
});

describe("/ticket mods", () => {
  it("sets both view+ping via mod roles", async () => {
    const role = makeRole({ name: "Mods" });
    const interaction = makeInteraction({
      subcommand: "mods",
      options: { role },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setTicketModRoles).toHaveBeenCalledWith(interaction.guild.id, [role.id]);
    expect(repliedText(interaction)).toMatch(/Mod Role Set/i);
  });
});

describe("/ticket auto-mods", () => {
  it("saves the auto category and reports matched roles (view-only default)", async () => {
    const r = makeRole({ name: "Helper", position: 5 });
    r.permissions = { toArray: () => ["ManageMessages", "KickMembers"] };
    getRolesByCategory.mockReturnValue([r]);

    const guild = makeGuild();
    guild.members.me.roles.highest.position = 100; // bot above the matched role
    const interaction = makeInteraction({
      guild,
      subcommand: "auto-mods",
      options: {}, // scope defaults to "staff", ping false
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);

    expect(setTicketAutoCategory).toHaveBeenCalledWith(guild.id, "view", "staff");
    // ping not requested -> only the view call
    expect(setTicketAutoCategory).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/Auto-Configured/i);
    expect(repliedText(interaction)).toMatch(/staff/);
  });

  it("also sets ping when ping:true and warns about roles above the bot", async () => {
    const high = makeRole({ name: "Owner", position: 200 });
    high.permissions = { toArray: () => ["Administrator"] };
    getRolesByCategory.mockReturnValue([high]);

    const guild = makeGuild();
    guild.members.me.roles.highest.position = 10; // bot BELOW the matched role
    const interaction = makeInteraction({
      guild,
      subcommand: "auto-mods",
      options: { scope: "admin", ping: true },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);

    expect(setTicketAutoCategory).toHaveBeenCalledWith(guild.id, "view", "admin");
    expect(setTicketAutoCategory).toHaveBeenCalledWith(guild.id, "ping", "admin");
    expect(repliedText(interaction)).toMatch(/above my top role/i);
  });
});

describe("/ticket welcome", () => {
  it("treats 'reset' as a clear (null) and a normal string as a set", async () => {
    const interaction = makeInteraction({
      subcommand: "welcome",
      options: { title: "reset", description: "Hello {user}" },
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setTicketWelcome).toHaveBeenCalledWith(interaction.guild.id, {
      title: null,
      description: "Hello {user}",
    });
  });

  it("omitted args are passed as undefined (no change)", async () => {
    const interaction = makeInteraction({
      subcommand: "welcome",
      options: {},
      permissions: [PermissionFlagsBits.Administrator],
    });
    await execute(interaction);
    expect(setTicketWelcome).toHaveBeenCalledWith(interaction.guild.id, {
      title: undefined,
      description: undefined,
    });
  });
});

describe("/ticket create", () => {
  it("refuses when no category is configured", async () => {
    dbState.cfg = freshCfg({ category_id: null });
    const interaction = makeInteraction({
      subcommand: "create",
      options: {},
      permissions: [],
    });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not Set Up/i);
  });

  it("creates a ticket channel and posts the welcome embed", async () => {
    dbState.cfg = freshCfg({ category_id: "cat-123" });
    resolveTicketRoles.mockResolvedValue({ view_role_ids: ["role-view"], ping_role_ids: ["role-ping"] });

    const guild = makeGuild();
    const user = makeUser({ username: "bob" });
    const interaction = makeInteraction({
      guild,
      user,
      subcommand: "create",
      options: { topic: "billing issue" },
      permissions: [],
    });

    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    const [opts] = guild.channels.create.mock.calls[0];
    expect(opts.type).toBe(ChannelType.GuildText);
    expect(opts.parent).toBe("cat-123");
    expect(opts.name).toContain("ticket-bob");
    // view role overwrite was added
    const viewOverwrite = opts.permissionOverwrites.find((o) => o.id === "role-view");
    expect(viewOverwrite).toBeTruthy();
    // success reply references the created channel
    expect(repliedText(interaction)).toMatch(/Ticket Created/i);
  });

  it("reports a failure embed when channel creation throws", async () => {
    dbState.cfg = freshCfg({ category_id: "cat-1" });
    const guild = makeGuild();
    guild.channels.create = vi.fn(async () => {
      throw new Error("no-perms");
    });
    const interaction = makeInteraction({
      guild,
      subcommand: "create",
      options: {},
      permissions: [],
    });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/Creation Failed/i);
    expect(repliedText(interaction)).toContain("no-perms");
  });
});

describe("/ticket close", () => {
  it("refuses outside a ticket channel", async () => {
    const channel = makeChannel({ name: "general" });
    const interaction = makeInteraction({
      channel,
      subcommand: "close",
      options: {},
      permissions: [],
    });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not a Ticket/i);
  });

  it("warns + schedules deletion inside a ticket channel", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const channel = makeChannel({ name: "ticket-bob-abc" });
    const interaction = makeInteraction({
      channel,
      subcommand: "close",
      options: {},
      permissions: [],
    });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/Closing Ticket/i);
    // Deletion is scheduled (not immediate) for ~5s.
    expect(channel.delete).not.toHaveBeenCalled();
    const scheduled = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5000);
    expect(scheduled).toBeTruthy();
    // Manually invoke the scheduled callback and confirm it deletes the channel.
    await scheduled[0]();
    expect(channel.delete).toHaveBeenCalledWith("Ticket closed");
    setTimeoutSpy.mockRestore();
  });
});

describe("ticket wizard handler (handleTicketWizard)", () => {
  it("refuses non-admin users", async () => {
    const interaction = makeInteraction({
      customId: "ticketwiz:home",
      permissions: [],
    });
    await handleTicketWizard(interaction);
    expect(repliedText(interaction)).toMatch(/only admins/i);
  });

  it("ignores customIds not prefixed with ticketwiz", async () => {
    const interaction = makeInteraction({
      customId: "somethingelse:home",
      permissions: [PermissionFlagsBits.Administrator],
    });
    const result = await handleTicketWizard(interaction);
    expect(result).toBeUndefined();
    expect(getReplies(interaction)).toHaveLength(0);
  });

  it("category:pick rejects a non-category channel", async () => {
    const ch = makeChannel({ name: "general", type: ChannelType.GuildText });
    const interaction = makeInteraction({
      customId: "ticketwiz:category:pick",
      permissions: [PermissionFlagsBits.Administrator],
    });
    interaction.channels = { first: () => ch };
    await handleTicketWizard(interaction);
    expect(setTicketCategory).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/pick a \*\*category\*\*/i);
  });

  it("category:pick saves a valid category and re-renders the hub", async () => {
    const guild = makeGuild();
    const cat = makeChannel({ name: "Tickets", type: ChannelType.GuildCategory, guild });
    const interaction = makeInteraction({
      guild,
      customId: "ticketwiz:category:pick",
      permissions: [PermissionFlagsBits.Administrator],
    });
    interaction.channels = { first: () => cat };
    await handleTicketWizard(interaction);
    expect(setTicketCategory).toHaveBeenCalledWith(guild.id, cat.id);
    expect(interaction.update).toHaveBeenCalled();
  });

  it("view:pick rejects @everyone (role id === guild id)", async () => {
    const guild = makeGuild();
    const everyoneRole = makeRole({ id: guild.id, name: "@everyone" });
    const interaction = makeInteraction({
      guild,
      customId: "ticketwiz:view:pick",
      permissions: [PermissionFlagsBits.Administrator],
    });
    interaction.roles = { first: () => everyoneRole };
    await handleTicketWizard(interaction);
    expect(setTicketViewRoles).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/@everyone/i);
  });

  it("view:clear wipes the list AND the auto-category", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({
      guild,
      customId: "ticketwiz:view:clear",
      permissions: [PermissionFlagsBits.Administrator],
    });
    await handleTicketWizard(interaction);
    expect(setTicketViewRoles).toHaveBeenCalledWith(guild.id, []);
    expect(setTicketAutoCategory).toHaveBeenCalledWith(guild.id, "view", null);
  });

  it("reset-all clears roles/auto/welcome/panel but keeps category", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({
      guild,
      customId: "ticketwiz:reset-all",
      permissions: [PermissionFlagsBits.Administrator],
    });
    await handleTicketWizard(interaction);
    expect(setTicketViewRoles).toHaveBeenCalledWith(guild.id, []);
    expect(setTicketPingRoles).toHaveBeenCalledWith(guild.id, []);
    expect(setTicketAutoCategory).toHaveBeenCalledWith(guild.id, "view", null);
    expect(setTicketAutoCategory).toHaveBeenCalledWith(guild.id, "ping", null);
    expect(setTicketWelcome).toHaveBeenCalled();
    // category never reset
    expect(setTicketCategory).not.toHaveBeenCalled();
  });
});
