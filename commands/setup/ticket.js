import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { successEmbed, errorEmbed, warnEmbed, primaryEmbed } from "../../utils/embeds.js";
import {
  getTicketConfig,
  setTicketCategory,
  setTicketViewRoles,
  setTicketPingRoles,
  setTicketModRoles,
  setTicketWelcome,
  setTicketPanel,
  setTicketPanelMessage,
  setTicketPanelChannel,
  setTicketAutoCategory,
} from "../../database.js";
import { log } from "../../utils/logger.js";

const E = MessageFlags.Ephemeral;

// ─── /ticket ───────────────────────────────────────────────────────────────
//
// By default, new tickets are visible ONLY to the opener and the bot. Access
// for staff should be handled at the CATEGORY level — whatever roles you give
// view perms on the ticket category will inherit into every ticket channel.
//
// For per-ticket extras (granting a role view on each new ticket, pinging a
// role on open, customizing the welcome embed), use `/ticket config` or the
// individual subcommands below.
// ────────────────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Manage the ticket system")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Open a new support ticket")
      .addStringOption((o) => o.setName("topic").setDescription("What do you need help with?").setRequired(false))
  )
  .addSubcommand((sub) => sub.setName("close").setDescription("Close and delete this ticket channel"))
  .addSubcommand((sub) =>
    sub
      .setName("setup")
      .setDescription("Set up the ticket system (Admin) — optionally pick a category or create 'TICKETS'")
      .addChannelOption((o) =>
        o.setName("category")
          .setDescription("Category where new tickets will live. Omit to use (or create) 'TICKETS'.")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("config")
      .setDescription("Show current ticket config (Admin)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("category")
      .setDescription("Change the category new tickets are created under (Admin)")
      .addChannelOption((o) =>
        o.setName("category")
          .setDescription("Category to use")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("view-role")
      .setDescription("Grant a role view+send access on every new ticket. Omit role to clear. (Admin)")
      .addRoleOption((o) => o.setName("role").setDescription("Role to grant access. Omit to clear.").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName("ping-role")
      .setDescription("Ping a role in the welcome message of each new ticket. Omit role to clear. (Admin)")
      .addRoleOption((o) => o.setName("role").setDescription("Role to ping. Omit to clear.").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName("mods")
      .setDescription("Shortcut: set one role for BOTH view access AND ping. Omit to clear both. (Admin)")
      .addRoleOption((o) => o.setName("role").setDescription("Mod role — grants view + pings. Omit to clear.").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName("welcome")
      .setDescription("Customize the welcome embed on new tickets (Admin). Omit both to reset to default.")
      .addStringOption((o) => o.setName("title").setDescription("Embed title. Use 'reset' to clear.").setRequired(false))
      .addStringOption((o) => o.setName("description").setDescription("Embed description. Use '{user}' to mention the opener. Use 'reset' to clear.").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName("auto-mods")
      .setDescription("Auto-populate view/ping roles from any role with mod/admin permissions (Admin)")
      .addStringOption((o) =>
        o.setName("scope")
          .setDescription("Which tier to pick up. Default: staff (admin+moderator).")
          .setChoices(
            { name: "staff (admin + moderator)", value: "staff" },
            { name: "admin only",                 value: "admin" },
            { name: "moderator only",             value: "moderator" },
            { name: "trusted (+helpers)",         value: "trusted" },
          )
          .setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("ping").setDescription("Also set these roles as ping-on-open. Default: false (view only).").setRequired(false)
      )
  );

// ────────────────────────────────────────────────────────────────────────────

function _requireAdmin(interaction) {
  if (!interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    interaction.reply({
      embeds: [errorEmbed("No Permission", "Only administrators can change the ticket system.")],
      ephemeral: true,
    }).catch(() => {});
    return false;
  }
  return true;
}

function _formatRoleList(guild, roleIds) {
  if (!roleIds?.length) return "*none*";
  return roleIds
    .map((id) => {
      const r = guild.roles.cache.get(id);
      return r ? `${r}` : `\`${id}\` *(deleted)*`;
    })
    .join(", ");
}

function _configEmbed(guild) {
  const cfg = getTicketConfig(guild.id);
  const cat = cfg.category_id ? guild.channels.cache.get(cfg.category_id) : null;
  return new EmbedBuilder()
    .setTitle("🎫 Ticket Config")
    .setColor(0x5865F2)
    .addFields(
      { name: "Category",     value: cat ? `${cat.name}` : cfg.category_id ? `\`${cfg.category_id}\` *(deleted)*` : "*not set — run `/ticket setup`*" },
      { name: "View roles",   value: _formatRoleList(guild, cfg.view_role_ids), inline: true },
      { name: "Ping roles",   value: _formatRoleList(guild, cfg.ping_role_ids), inline: true },
      { name: "Welcome title",       value: cfg.welcome_title ? `\`${cfg.welcome_title}\`` : "*default*" },
      { name: "Welcome description", value: cfg.welcome_description ? `\`\`\`\n${cfg.welcome_description.slice(0, 900)}\n\`\`\`` : "*default*" },
    )
    .setFooter({ text: "Change with /ticket category, view-role, ping-role, mods, welcome" });
}

// ────────────────────────────────────────────────────────────────────────────

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // ── setup (launches the interactive wizard) ────────────────────────────
  if (sub === "setup") {
    if (!_requireAdmin(interaction)) return;
    await interaction.deferReply({ flags: E }).catch(() => {});

    // If the admin passed an explicit category, fast-path it (power-user shortcut).
    const explicitCategory = interaction.options.getChannel("category");
    if (explicitCategory) {
      setTicketCategory(interaction.guild.id, explicitCategory.id);
    }

    return _safeEditReply(interaction, renderWizardHome(interaction.guild));
  }

  // ── config (read-only view of current settings) ──────────────────────────
  if (sub === "config") {
    if (!_requireAdmin(interaction)) return;
    return interaction.reply({ embeds: [_configEmbed(interaction.guild)], ephemeral: true }).catch(() => {});
  }

  // ── category (change target) ─────────────────────────────────────────────
  if (sub === "category") {
    if (!_requireAdmin(interaction)) return;
    const cat = interaction.options.getChannel("category");
    setTicketCategory(interaction.guild.id, cat.id);
    return interaction.reply({
      embeds: [successEmbed("Category Updated", `New tickets will now be created under **${cat.name}**.`)],
      ephemeral: true,
    }).catch(() => {});
  }

  // ── view-role (set or clear) ─────────────────────────────────────────────
  if (sub === "view-role") {
    if (!_requireAdmin(interaction)) return;
    const role = interaction.options.getRole("role");
    setTicketViewRoles(interaction.guild.id, role ? [role.id] : []);
    return interaction.reply({
      embeds: [successEmbed(role ? "View Role Set" : "View Roles Cleared", role
        ? `${role} will be granted **view + send** access on every new ticket.`
        : "No role will be auto-granted access. Access is now controlled by the category's permissions only."
      )],
      ephemeral: true,
    }).catch(() => {});
  }

  // ── ping-role (set or clear) ─────────────────────────────────────────────
  if (sub === "ping-role") {
    if (!_requireAdmin(interaction)) return;
    const role = interaction.options.getRole("role");
    setTicketPingRoles(interaction.guild.id, role ? [role.id] : []);
    return interaction.reply({
      embeds: [successEmbed(role ? "Ping Role Set" : "Ping Roles Cleared", role
        ? `${role} will be **pinged** in the welcome message of every new ticket.`
        : "No role will be pinged on new tickets."
      )],
      ephemeral: true,
    }).catch(() => {});
  }

  // ── mods (combined shortcut: view + ping on one role) ────────────────────
  if (sub === "mods") {
    if (!_requireAdmin(interaction)) return;
    const role = interaction.options.getRole("role");
    setTicketModRoles(interaction.guild.id, role ? [role.id] : []);
    return interaction.reply({
      embeds: [successEmbed(role ? "Mod Role Set" : "Mod Roles Cleared", role
        ? `${role} will **both** get view access and be pinged on every new ticket.`
        : "Cleared view AND ping roles."
      )],
      ephemeral: true,
    }).catch(() => {});
  }

  // ── auto-mods (categorize by permissions + populate view/ping) ──────────
  // Saves the CATEGORY KEYWORD instead of a frozen list of role IDs, so the
  // resolution is dynamic — add a new role with mod perms later and the
  // ticket system picks it up automatically without rerun.
  if (sub === "auto-mods") {
    if (!_requireAdmin(interaction)) return;
    const scope = interaction.options.getString("scope") || "staff";
    const alsoPing = !!interaction.options.getBoolean("ping");
    const { getRolesByCategory } = await import("../../utils/roleCategorizer.js");
    const currentMatches = getRolesByCategory(interaction.guild, scope);

    setTicketAutoCategory(interaction.guild.id, "view", scope);
    if (alsoPing) setTicketAutoCategory(interaction.guild.id, "ping", scope);

    const me = interaction.guild.members.me;
    const aboveIrene = me ? currentMatches.filter((r) => r.position >= me.roles.highest.position) : [];

    const lines = [
      `Auto-resolving **${scope}** category on every new ticket. Currently matches **${currentMatches.length}** role(s):`,
      currentMatches.length ? currentMatches.map((r) => `• ${r} *(${r.permissions.toArray().length} perms)*`).join("\n") : "*none — nobody on this server currently has the perms for this category. If you add a matching role later, it'll be picked up automatically.*",
    ];
    if (alsoPing) lines.push("\nAlso set as ping-on-open.");
    if (aboveIrene.length) {
      lines.push(`\n⚠️ ${aboveIrene.length} role(s) are above my top role — I can still grant them view access on a ticket channel, but I can't manage the roles themselves.`);
    }
    lines.push("\n*This is dynamic — run `/ticket view-role` to pin specific roles alongside the auto set, or `/ticket auto-mods` again to switch scope.*");
    return interaction.reply({
      embeds: [successEmbed("Auto-Configured", lines.join("\n"))],
      ephemeral: true,
    }).catch(() => {});
  }

  // ── welcome (customize embed title / description) ────────────────────────
  if (sub === "welcome") {
    if (!_requireAdmin(interaction)) return;
    const rawTitle = interaction.options.getString("title");
    const rawDesc  = interaction.options.getString("description");
    const titleArg = rawTitle === null ? undefined : (rawTitle.toLowerCase() === "reset" ? null : rawTitle);
    const descArg  = rawDesc  === null ? undefined : (rawDesc.toLowerCase()  === "reset" ? null : rawDesc);
    setTicketWelcome(interaction.guild.id, { title: titleArg, description: descArg });

    const updated = _configEmbed(interaction.guild);
    return interaction.reply({
      embeds: [successEmbed("Welcome Updated", "Preview:"), updated],
      ephemeral: true,
    }).catch(() => {});
  }

  // ── create (user opens a ticket) ─────────────────────────────────────────
  if (sub === "create") {
    const cfg = getTicketConfig(interaction.guild.id);
    if (!cfg.category_id) {
      return interaction.reply({
        embeds: [errorEmbed("Not Set Up", "An administrator needs to run `/ticket setup` first.")],
        ephemeral: true,
      }).catch(() => {});
    }

    // Defer — channel create + send chain can cross the 3s token window.
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const topic      = interaction.options.getString("topic") || null;
    const ticketName = `ticket-${interaction.user.username}-${Date.now().toString(36)}`;

    // Dynamic resolution: explicit pinned IDs UNION live lookup against any
    // configured auto_category. New mod roles added after setup-time will
    // show up here without needing /ticket auto-mods to be rerun.
    const { resolveTicketRoles } = await import("../../database.js");
    const { view_role_ids: viewRoleIds, ping_role_ids: pingRoleIds } = await resolveTicketRoles(interaction.guild);

    const overwrites = [
      { id: interaction.guild.id,       deny:  [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id,        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ];
    for (const roleId of viewRoleIds) {
      overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }

    try {
      const channel = await interaction.guild.channels.create({
        name: ticketName,
        type: ChannelType.GuildText,
        parent: cfg.category_id,
        permissionOverwrites: overwrites,
        reason: `Ticket opened by ${interaction.user.tag}`,
      });

      const defaultTitle = "🎫 Support Ticket";
      const defaultDesc  = `${interaction.user}, a staff member will be with you shortly. Please describe your issue in full detail below.`;
      const welcomeTitle = cfg.welcome_title || defaultTitle;
      const welcomeDesc  = (cfg.welcome_description || defaultDesc).replace(/\{user\}/g, `<@${interaction.user.id}>`);
      const welcomeColor = typeof cfg.welcome_color === "number" ? cfg.welcome_color : 0x5865F2;
      const welcomeEmbed = new EmbedBuilder().setColor(welcomeColor).setTitle(welcomeTitle).setDescription(welcomeDesc);
      if (topic) welcomeEmbed.addFields({ name: "📋 Topic", value: topic.slice(0, 1024) });

      const pingContent = pingRoleIds.length ? pingRoleIds.map((id) => `<@&${id}>`).join(" ") : undefined;
      await channel.send({
        content: pingContent,
        allowedMentions: { users: [interaction.user.id], roles: pingRoleIds },
        embeds: [welcomeEmbed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ticket_close:${channel.id}`).setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`ticket_claim:${channel.id}`).setLabel("Claim").setEmoji("🙋").setStyle(ButtonStyle.Primary),
          ),
        ],
      });

      await interaction.editReply({
        embeds: [successEmbed("Ticket Created", `Your ticket has been opened in ${channel}.`)],
      }).catch(() => {});
    } catch (error) {
      await interaction.editReply({
        embeds: [errorEmbed("Creation Failed", `Could not create the ticket channel: ${error.message}`)],
      }).catch(() => {});
    }
    return;
  }

  // ── close (close + delete this ticket channel) ───────────────────────────
  if (sub === "close") {
    if (!interaction.channel.name.startsWith("ticket-")) {
      return interaction.reply({
        embeds: [errorEmbed("Not a Ticket", "This command can only be used inside a ticket channel.")],
        ephemeral: true,
      }).catch(() => {});
    }
    await interaction.reply({
      embeds: [warnEmbed("Closing Ticket", `Closed by **${interaction.user.tag}**. This channel will be deleted in 5 seconds...`)],
    }).catch(() => {});
    setTimeout(async () => {
      try { await interaction.channel.delete("Ticket closed").catch(() => {}); } catch {}
    }, 5000);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ─── Interactive ticket setup wizard ──────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
// Single-page hub: every knob is visible and editable without leaving the
// message. Routed from events/interactionCreate.js via the `ticketwiz:`
// customId prefix.
//
// customId layout: ticketwiz:<action>[:<sub>]
//   ticketwiz:home                   — re-render (navigation)
//   ticketwiz:category:pick          — channel select → save category
//   ticketwiz:view:pick              — role select    → save view role
//   ticketwiz:view:clear             — clear view roles
//   ticketwiz:ping:pick              — role select    → save ping role
//   ticketwiz:ping:clear             — clear ping roles
//   ticketwiz:welcome:edit           — open modal with title + description
//   ticketwiz:welcome:modal (modal)  — modal submit  → save welcome
//   ticketwiz:welcome:reset          — reset welcome to defaults
//   ticketwiz:panel:post             — post the open-ticket panel
//   ticketwiz:done                   — finalize and dismiss
//   ticketwiz:reset-all              — wipe category + view + ping + welcome
// ────────────────────────────────────────────────────────────────────────────

async function _safeEditReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return;
    log(`[TicketWizard] reply failed: ${err?.message || err}`);
  }
}

async function _safeUpdate(interaction, payload) {
  try { await interaction.update(payload); }
  catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return;
    log(`[TicketWizard] update failed: ${err?.message || err}`);
  }
}

function _hasManageGuild(member) {
  try { return !!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) || !!member?.permissions?.has?.(PermissionFlagsBits.Administrator); } catch { return false; }
}

function _formatRoleInline(guild, roleIds) {
  if (!roleIds?.length) return "*none*";
  return roleIds
    .map((id) => {
      const r = guild.roles.cache.get(id);
      return r ? `${r}` : `\`${id}\` *(deleted)*`;
    })
    .join(", ");
}

function _hex(n) {
  return typeof n === "number" ? "#" + n.toString(16).padStart(6, "0").toUpperCase() : null;
}

function renderWizardHome(guild) {
  const cfg = getTicketConfig(guild.id);
  const cat = cfg.category_id ? guild.channels.cache.get(cfg.category_id) : null;
  const panelCh = cfg.panel_channel_id ? guild.channels.cache.get(cfg.panel_channel_id) : null;
  const panelLive = !!(panelCh && cfg.panel_message_id);

  const welcomeCustom = !!(cfg.welcome_title || cfg.welcome_description || cfg.welcome_color);
  const panelCustom   = !!(cfg.panel_title || cfg.panel_description || cfg.panel_color || cfg.panel_button_label || cfg.panel_button_emoji);

  const viewBits = [];
  if (cfg.view_role_ids.length) viewBits.push(_formatRoleInline(guild, cfg.view_role_ids));
  if (cfg.view_auto_category) viewBits.push(`*auto:* **${cfg.view_auto_category}** (resolved live)`);
  const pingBits = [];
  if (cfg.ping_role_ids.length) pingBits.push(_formatRoleInline(guild, cfg.ping_role_ids));
  if (cfg.ping_auto_category) pingBits.push(`*auto:* **${cfg.ping_auto_category}** (resolved live)`);

  // Types summary: show "default (1 button, global category)" when none
  // defined, or a short listing when present.
  const typesList = Array.isArray(cfg.types) ? cfg.types : [];
  let typesLine;
  if (!typesList.length) {
    typesLine = `🎟️  **Types** · *default (1 button, uses global category)*`;
  } else {
    const bits = typesList.slice(0, 6).map((t) => {
      const catCh = t.category_id ? guild.channels.cache.get(t.category_id) : null;
      const dest = catCh ? `#${catCh.name}` : (cat ? `#${cat.name} *(fallback)*` : "*no category*");
      return `• ${t.emoji ? `${t.emoji} ` : ""}**${t.label}** → ${dest}`;
    });
    if (typesList.length > 6) bits.push(`*…and ${typesList.length - 6} more*`);
    typesLine = `🎟️  **Types** · **${typesList.length}** configured:\n${bits.join("\n")}`;
  }

  const statusLines = [
    `📁  **Category** · ${cat ? `${cat.name}` : (cfg.category_id ? `\`${cfg.category_id}\` *(deleted)*` : "*not set — pick one below*")}`,
    typesLine,
    `👁️  **View** · ${viewBits.length ? viewBits.join(" + ") : "*none*"}`,
    `🔔  **Ping** · ${pingBits.length ? pingBits.join(" + ") : "*none*"}`,
    `💬  **Welcome embed** · ${welcomeCustom ? `*custom* ${_hex(cfg.welcome_color) || ""}`.trim() : "*default*"}`,
    `🎨  **Panel embed** · ${panelCustom ? `*custom* ${_hex(cfg.panel_color) || ""}`.trim() : "*default*"}`,
    `📣  **Panel channel** · ${panelCh ? (panelLive ? `${panelCh} ([jump](https://discord.com/channels/${guild.id}/${panelCh.id}/${cfg.panel_message_id}))` : `${panelCh} (not posted yet)`) : "*auto — will create #open-ticket under the category*"}`,
  ];

  const embed = primaryEmbed("🎫  Ticket Setup", [
    "Tweak any option and I'll save instantly. Defaults are safe — nothing is pinged or auto-shared with mods unless you add roles here.",
    "",
    ...statusLines,
    "",
    "*Tip: staff access can also come from the ticket category's own permissions — you don't have to add a view role here if the category is already staff-only. `Post Panel` edits the existing panel in place if one's already live.*",
  ].join("\n"));

  const categorySelect = new ChannelSelectMenuBuilder()
    .setCustomId("ticketwiz:category:pick")
    .setPlaceholder(cat ? `📁  Change category (current: ${cat.name})` : "📁  Pick the ticket category…")
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  const viewSelect = new RoleSelectMenuBuilder()
    .setCustomId("ticketwiz:view:pick")
    .setPlaceholder(cfg.view_role_ids.length ? "👁️  Change view role…" : "👁️  Pick a role that sees every ticket (optional)")
    .setMinValues(1)
    .setMaxValues(1);

  const pingSelect = new RoleSelectMenuBuilder()
    .setCustomId("ticketwiz:ping:pick")
    .setPlaceholder(cfg.ping_role_ids.length ? "🔔  Change ping role…" : "🔔  Pick a role to ping on open (optional)")
    .setMinValues(1)
    .setMaxValues(1);

  // Row 4: embed editors + quick clears (5 max per row).
  const editRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticketwiz:welcome:edit").setLabel("Edit Welcome").setStyle(ButtonStyle.Primary).setEmoji("💬"),
    new ButtonBuilder().setCustomId("ticketwiz:panel:edit").setLabel("Edit Panel").setStyle(ButtonStyle.Primary).setEmoji("🎨"),
    new ButtonBuilder().setCustomId("ticketwiz:panel-channel:open").setLabel("Panel Channel").setStyle(ButtonStyle.Secondary).setEmoji("📣"),
    new ButtonBuilder().setCustomId("ticketwiz:view:clear").setLabel("Clear View").setStyle(ButtonStyle.Secondary).setEmoji("🧹").setDisabled(!cfg.view_role_ids.length),
    new ButtonBuilder().setCustomId("ticketwiz:ping:clear").setLabel("Clear Ping").setStyle(ButtonStyle.Secondary).setEmoji("🧹").setDisabled(!cfg.ping_role_ids.length),
  );

  // Row 5: terminal actions. Post Panel upserts (edits if already live).
  const finishRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticketwiz:panel:post").setLabel(panelLive ? "Update Panel" : "Post Panel").setStyle(ButtonStyle.Success).setEmoji(panelLive ? "🔄" : "📣").setDisabled(!cfg.category_id),
    new ButtonBuilder().setCustomId("ticketwiz:panel:unlink").setLabel("Unlink Panel").setStyle(ButtonStyle.Secondary).setEmoji("🔗").setDisabled(!panelLive),
    new ButtonBuilder().setCustomId("ticketwiz:reset-all").setLabel("Reset All").setStyle(ButtonStyle.Danger).setEmoji("💥"),
    new ButtonBuilder().setCustomId("ticketwiz:done").setLabel("Done").setStyle(ButtonStyle.Secondary).setEmoji("✅"),
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(categorySelect),
      new ActionRowBuilder().addComponents(viewSelect),
      new ActionRowBuilder().addComponents(pingSelect),
      editRow,
      finishRow,
    ],
    flags: E,
  };
}

function _buildWelcomeModal(guild) {
  const cfg = getTicketConfig(guild.id);
  const modal = new ModalBuilder()
    .setCustomId("ticketwiz:welcome:modal")
    .setTitle("Welcome Embed");

  const titleInput = new TextInputBuilder()
    .setCustomId("welcome_title")
    .setLabel("Title (blank = default)")
    .setPlaceholder("🎫 Support Ticket")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(256);
  if (cfg.welcome_title) titleInput.setValue(cfg.welcome_title.slice(0, 256));

  const descInput = new TextInputBuilder()
    .setCustomId("welcome_description")
    .setLabel("Description — use {user} for the opener")
    .setPlaceholder("Hey {user}, describe your issue and a staff member will assist you shortly.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(4000);
  if (cfg.welcome_description) descInput.setValue(cfg.welcome_description.slice(0, 4000));

  const colorInput = new TextInputBuilder()
    .setCustomId("welcome_color")
    .setLabel("Color — hex like #5865F2 (blank = default)")
    .setPlaceholder("#5865F2")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(10);
  if (typeof cfg.welcome_color === "number") colorInput.setValue(_hex(cfg.welcome_color) || "");

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(colorInput),
  );
  return modal;
}

function _buildPanelModal(guild) {
  const cfg = getTicketConfig(guild.id);
  const modal = new ModalBuilder()
    .setCustomId("ticketwiz:panel:modal")
    .setTitle("Panel Embed");

  const titleInput = new TextInputBuilder()
    .setCustomId("panel_title")
    .setLabel("Title (blank = default)")
    .setPlaceholder("🎫 Support Tickets")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(256);
  if (cfg.panel_title) titleInput.setValue(cfg.panel_title.slice(0, 256));

  const descInput = new TextInputBuilder()
    .setCustomId("panel_description")
    .setLabel("Description (blank = default)")
    .setPlaceholder("Need help? Click the button below to open a private ticket with the staff team.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(4000);
  if (cfg.panel_description) descInput.setValue(cfg.panel_description.slice(0, 4000));

  const colorInput = new TextInputBuilder()
    .setCustomId("panel_color")
    .setLabel("Color — hex like #5865F2 (blank = default)")
    .setPlaceholder("#5865F2")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(10);
  if (typeof cfg.panel_color === "number") colorInput.setValue(_hex(cfg.panel_color) || "");

  const labelInput = new TextInputBuilder()
    .setCustomId("panel_button_label")
    .setLabel("Button label (blank = 'Open Ticket')")
    .setPlaceholder("Open Ticket")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);
  if (cfg.panel_button_label) labelInput.setValue(cfg.panel_button_label.slice(0, 80));

  const emojiInput = new TextInputBuilder()
    .setCustomId("panel_button_emoji")
    .setLabel("Button emoji (blank = 🎫)")
    .setPlaceholder("🎫")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(64);
  if (cfg.panel_button_emoji) emojiInput.setValue(cfg.panel_button_emoji.slice(0, 64));

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(colorInput),
    new ActionRowBuilder().addComponents(labelInput),
    new ActionRowBuilder().addComponents(emojiInput),
  );
  return modal;
}

// Build the panel embed + button(s) from the current config.
// - If the guild has ticket TYPES defined, emit one button per type (up to
//   25, arranged 5 per row). Each button's customId is "ticket_create:<key>"
//   so the creation handler knows which type was picked.
// - Otherwise emit a single "Open Ticket" button with customId "ticket_create"
//   (legacy/default behavior, preserved for simple one-category setups).
function _buildPanelPayload(cfg) {
  const embed = new EmbedBuilder()
    .setTitle(cfg.panel_title || "🎫 Support Tickets")
    .setDescription(cfg.panel_description || "Need help? Click the button below to open a private ticket with the staff team.")
    .setColor(typeof cfg.panel_color === "number" ? cfg.panel_color : 0x5865F2);

  const styleFrom = (name) => ({
    Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success, Danger: ButtonStyle.Danger,
  }[name] || ButtonStyle.Primary);

  const types = Array.isArray(cfg.types) ? cfg.types : [];
  const components = [];

  if (types.length) {
    // Arrange up to 25 buttons in rows of 5.
    const capped = types.slice(0, 25);
    for (let i = 0; i < capped.length; i += 5) {
      const slice = capped.slice(i, i + 5);
      const row = new ActionRowBuilder().addComponents(
        slice.map((t) => {
          const btn = new ButtonBuilder()
            .setCustomId(`ticket_create:${t.key}`)
            .setLabel(t.label || "Open")
            .setStyle(styleFrom(t.style));
          if (t.emoji) {
            try { btn.setEmoji(String(t.emoji).trim()); } catch { /* invalid emoji — skip */ }
          }
          return btn;
        })
      );
      components.push(row);
    }
  } else {
    const btn = new ButtonBuilder()
      .setCustomId("ticket_create")
      .setLabel(cfg.panel_button_label || "Open Ticket")
      .setStyle(ButtonStyle.Primary);
    const emoji = (cfg.panel_button_emoji || "🎫").trim();
    if (emoji) {
      try { btn.setEmoji(emoji); } catch { /* bad emoji — skip */ }
    }
    components.push(new ActionRowBuilder().addComponents(btn));
  }

  return { embeds: [embed], components };
}

// Custom emoji validity check for modal input — Discord accepts unicode OR
// `<a?:name:id>` custom-emoji format. This is best-effort; if invalid, we
// still save the raw string and fall back to 🎫 at render time.
function _maybeSanitizeEmoji(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  // Strip wrapping whitespace, keep as-is.
  return s.slice(0, 64);
}

// Temporary "pick a panel channel" view — replaces the hub while the admin
// picks a target channel. "Auto" restores default behavior (create/use
// #open-ticket under the ticket category). Back returns to the hub.
function renderPanelChannelPicker(guild) {
  const cfg = getTicketConfig(guild.id);
  const current = cfg.panel_channel_id ? guild.channels.cache.get(cfg.panel_channel_id) : null;

  const embed = primaryEmbed("📣  Pick Panel Channel", [
    "Choose a channel where the open-ticket panel will be posted.",
    "",
    current ? `Current: ${current}` : "Current: *auto — Irene will create/use* `#open-ticket` *under the ticket category*",
    "",
    "*This is separate from the ticket category — the category controls where opened ticket channels live; this controls where the 'Open Ticket' button is posted.*",
  ].join("\n"));

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId("ticketwiz:panel-channel:pick")
    .setPlaceholder("Pick a text channel for the panel…")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticketwiz:panel-channel:auto").setLabel("Use Auto (#open-ticket)").setStyle(ButtonStyle.Secondary).setEmoji("🪄"),
    new ButtonBuilder().setCustomId("ticketwiz:home").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      actions,
    ],
    flags: E,
  };
}

export async function handleTicketWizard(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "ticket setup only works in a server", flags: E }).catch(() => {});
  }
  if (!_hasManageGuild(interaction.member)) {
    return interaction.reply({ content: "only admins can use the ticket setup wizard", flags: E }).catch(() => {});
  }

  const parts = (interaction.customId || "").split(":");
  if (parts[0] !== "ticketwiz") return;
  const action = parts[1];
  const sub = parts[2];
  const guild = interaction.guild;
  const gid = guild.id;

  // ── Navigation (return to home) ────────────────────────────────────────
  if (action === "home") {
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Category: channel select ──────────────────────────────────────────
  if (action === "category" && sub === "pick") {
    const ch = interaction.channels?.first?.() ?? guild.channels.cache.get(interaction.values?.[0]);
    if (!ch || ch.type !== ChannelType.GuildCategory) {
      return interaction.reply({ content: "pick a **category** (not a channel) — try again", flags: E }).catch(() => {});
    }
    if (ch.guild?.id && ch.guild.id !== gid) {
      return interaction.reply({ content: "category has to be in this server", flags: E }).catch(() => {});
    }
    setTicketCategory(gid, ch.id);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── View role: set / clear ────────────────────────────────────────────
  if (action === "view" && sub === "pick") {
    const role = interaction.roles?.first?.() ?? guild.roles.cache.get(interaction.values?.[0]);
    if (!role) return interaction.reply({ content: "couldn't resolve that role — try again", flags: E }).catch(() => {});
    if (role.id === gid) return interaction.reply({ content: "`@everyone` would make every ticket public — pick a real role", flags: E }).catch(() => {});
    setTicketViewRoles(gid, [role.id]);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }
  if (action === "view" && sub === "clear") {
    // Clear BOTH the pinned list and the auto-category. Otherwise a stale
    // auto:staff rule would quietly re-grant access after an admin hits
    // "Clear View" expecting a fresh slate.
    setTicketViewRoles(gid, []);
    setTicketAutoCategory(gid, "view", null);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Ping role: set / clear ────────────────────────────────────────────
  if (action === "ping" && sub === "pick") {
    const role = interaction.roles?.first?.() ?? guild.roles.cache.get(interaction.values?.[0]);
    if (!role) return interaction.reply({ content: "couldn't resolve that role — try again", flags: E }).catch(() => {});
    if (role.id === gid) return interaction.reply({ content: "pinging `@everyone` on every ticket would be a nightmare — pick a staff role", flags: E }).catch(() => {});
    setTicketPingRoles(gid, [role.id]);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }
  if (action === "ping" && sub === "clear") {
    setTicketPingRoles(gid, []);
    setTicketAutoCategory(gid, "ping", null);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Welcome editor: open modal ────────────────────────────────────────
  if (action === "welcome" && sub === "edit") {
    try { await interaction.showModal(_buildWelcomeModal(guild)); }
    catch (err) { log(`[TicketWizard] showModal failed: ${err?.message || err}`); }
    return;
  }
  // Welcome modal submit — edits the wizard message in place.
  if (action === "welcome" && sub === "modal" && interaction.isModalSubmit?.()) {
    const rawTitle = interaction.fields.getTextInputValue("welcome_title") || "";
    const rawDesc  = interaction.fields.getTextInputValue("welcome_description") || "";
    const rawColor = interaction.fields.getTextInputValue("welcome_color") || "";
    setTicketWelcome(gid, {
      title: rawTitle.trim() || null,
      description: rawDesc.trim() || null,
      color: rawColor.trim() || null,
    });
    return _safeUpdate(interaction, renderWizardHome(guild));
  }
  if (action === "welcome" && sub === "reset") {
    setTicketWelcome(gid, { title: null, description: null, color: null });
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Panel embed editor ────────────────────────────────────────────────
  if (action === "panel" && sub === "edit") {
    try { await interaction.showModal(_buildPanelModal(guild)); }
    catch (err) { log(`[TicketWizard] showModal failed: ${err?.message || err}`); }
    return;
  }
  if (action === "panel" && sub === "modal" && interaction.isModalSubmit?.()) {
    const rawTitle = interaction.fields.getTextInputValue("panel_title") || "";
    const rawDesc  = interaction.fields.getTextInputValue("panel_description") || "";
    const rawColor = interaction.fields.getTextInputValue("panel_color") || "";
    const rawLabel = interaction.fields.getTextInputValue("panel_button_label") || "";
    const rawEmoji = interaction.fields.getTextInputValue("panel_button_emoji") || "";
    setTicketPanel(gid, {
      title:        rawTitle.trim() || null,
      description:  rawDesc.trim()  || null,
      color:        rawColor.trim() || null,
      button_label: rawLabel.trim() || null,
      button_emoji: _maybeSanitizeEmoji(rawEmoji),
    });

    // If a panel is already live, push the new content to it in real time.
    const after = getTicketConfig(gid);
    if (after.panel_channel_id && after.panel_message_id) {
      try {
        const ch = guild.channels.cache.get(after.panel_channel_id);
        if (ch?.isTextBased?.()) {
          const msg = await ch.messages.fetch(after.panel_message_id).catch(() => null);
          if (msg) await msg.edit(_buildPanelPayload(after)).catch(() => {});
        }
      } catch { /* ignore — edit is best-effort, hub still reflects saved config */ }
    }
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Post OR update the open-ticket panel ──────────────────────────────
  if (action === "panel" && sub === "post") {
    const cfg = getTicketConfig(gid);
    if (!cfg.category_id) {
      return interaction.reply({ content: "pick a category first so I know where to put the panel", flags: E }).catch(() => {});
    }
    const category = guild.channels.cache.get(cfg.category_id);
    if (!category) {
      return interaction.reply({ content: "the ticket category got deleted — pick a new one first", flags: E }).catch(() => {});
    }

    // Resolve channel to post/edit in — priority:
    // 1. Existing stored panel channel (if it still exists).
    // 2. Existing #open-ticket under the category.
    // 3. Create a new #open-ticket channel.
    let panelCh = null;
    let existingMsg = null;
    if (cfg.panel_channel_id) {
      panelCh = guild.channels.cache.get(cfg.panel_channel_id) || null;
      if (panelCh && cfg.panel_message_id) {
        existingMsg = await panelCh.messages.fetch(cfg.panel_message_id).catch(() => null);
      }
    }
    if (!panelCh) {
      panelCh = guild.channels.cache.find((c) => c.name === "open-ticket" && c.parentId === category.id) || null;
    }

    try {
      if (!panelCh) {
        panelCh = await guild.channels.create({
          name: "open-ticket",
          type: ChannelType.GuildText,
          parent: category.id,
          reason: "Ticket panel channel",
        });
      }
      const payload = _buildPanelPayload(cfg);
      if (existingMsg) {
        await existingMsg.edit(payload);
        setTicketPanelMessage(gid, panelCh.id, existingMsg.id);
      } else {
        const posted = await panelCh.send(payload);
        setTicketPanelMessage(gid, panelCh.id, posted.id);
      }
    } catch (err) {
      return interaction.reply({ content: `couldn't post panel: ${err?.message || err}`, flags: E }).catch(() => {});
    }

    await _safeUpdate(interaction, renderWizardHome(guild));
    await interaction.followUp({
      content: existingMsg ? `🔄 Panel updated in ${panelCh}.` : `✅ Panel posted in ${panelCh}.`,
      flags: E,
    }).catch(() => {});
    return;
  }

  // ── Unlink the stored panel reference (doesn't delete the message) ────
  if (action === "panel" && sub === "unlink") {
    setTicketPanelMessage(gid, null, null);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Panel channel picker (opens temporary sub-view) ───────────────────
  if (action === "panel-channel" && sub === "open") {
    return _safeUpdate(interaction, renderPanelChannelPicker(guild));
  }
  if (action === "panel-channel" && sub === "pick") {
    const ch = interaction.channels?.first?.() ?? guild.channels.cache.get(interaction.values?.[0]);
    if (!ch || !ch.isTextBased?.()) {
      return interaction.reply({ content: "pick a text or announcement channel", flags: E }).catch(() => {});
    }
    if (ch.guild?.id && ch.guild.id !== gid) {
      return interaction.reply({ content: "channel has to be in this server", flags: E }).catch(() => {});
    }
    // Verify the bot can actually send there — pointing the panel at a
    // channel Irene can't reach would only fail later on Post Panel.
    const me = guild.members.me;
    const perms = me ? ch.permissionsFor?.(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return interaction.reply({ content: `I need View Channel + Send Messages + Embed Links in ${ch} to post the panel there.`, flags: E }).catch(() => {});
    }
    setTicketPanelChannel(gid, ch.id);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }
  if (action === "panel-channel" && sub === "auto") {
    setTicketPanelChannel(gid, null);
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Reset everything to zero ───────────────────────────────────────────
  if (action === "reset-all") {
    setTicketViewRoles(gid, []);
    setTicketPingRoles(gid, []);
    setTicketAutoCategory(gid, "view", null);
    setTicketAutoCategory(gid, "ping", null);
    setTicketWelcome(gid, { title: null, description: null, color: null });
    setTicketPanel(gid, { title: null, description: null, color: null, button_label: null, button_emoji: null });
    // Intentionally DON'T wipe the category or the stored panel message id —
    // admin probably doesn't want to rebuild from nothing. If they do, they
    // can pick a different category or click Unlink Panel.
    return _safeUpdate(interaction, renderWizardHome(guild));
  }

  // ── Done ───────────────────────────────────────────────────────────────
  if (action === "done") {
    const cfg = getTicketConfig(gid);
    const summary = primaryEmbed("🎫  Ticket Setup Saved", [
      cfg.category_id ? `Category: <#${cfg.category_id}>` : "⚠️ No category set — users can't open tickets yet.",
      `View role: ${_formatRoleInline(guild, cfg.view_role_ids)}`,
      `Ping role: ${_formatRoleInline(guild, cfg.ping_role_ids)}`,
      cfg.welcome_title || cfg.welcome_description ? "Welcome: *customized*" : "Welcome: *default*",
      "",
      "Run `/ticket setup` any time to tweak these. `/ticket config` shows the current state.",
    ].join("\n"));
    return _safeUpdate(interaction, { embeds: [summary], components: [], flags: E });
  }

  // Fallback — unknown ticketwiz action
  return _safeUpdate(interaction, renderWizardHome(guild));
}
