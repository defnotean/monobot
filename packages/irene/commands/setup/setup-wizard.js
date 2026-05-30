import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, EmbedBuilder, StringSelectMenuBuilder, MessageFlags } from "discord.js";
import { primaryEmbed, successEmbed, errorEmbed, infoEmbed } from "../../utils/embeds.js";
import { getGuildSettings, setLogChannel, setWelcomeChannel, setGuildSetting } from "../../database.js";
import { log } from "../../utils/logger.js";
import { validateAssignableRole } from "../../ai/executors/customCommandExecutor.js";

// ─── Setup Wizard ───────────────────────────────────────────────────────────
// Multi-page button-driven config flow. One command opens the main menu,
// every configuration surface is one click away. Prefers native Discord
// select menus (channel / role pickers) over text entry wherever possible.
//
// Custom ID convention: setupwiz:<page>[:<action>[:<sub>]]
// Pages: home | welcome | modlog | automod | leveling | starboard | autorole | birthday | preview

const E = MessageFlags.Ephemeral;

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Interactive setup wizard — configure Irene's features in one place")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "setup wizard can only be used in a server", flags: E }).catch(() => {});
  }
  const member = await _ensureMember(interaction);
  if (!_hasManageGuild(member)) {
    return interaction.reply({ embeds: [errorEmbed("Need Manage Server", "only admins can run the setup wizard")], flags: E }).catch(() => {});
  }
  // Defer early — reading guild settings may touch the DB on first hit
  await interaction.deferReply({ flags: E }).catch(() => {});
  const payload = renderHome(interaction.guild);
  await _safeEditReply(interaction, payload);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _hasManageGuild(member) {
  try { return !!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild); } catch { return false; }
}

async function _ensureMember(interaction) {
  if (interaction.member?.permissions?.has) return interaction.member;
  try { return await interaction.guild.members.fetch(interaction.user.id); } catch { return null; }
}

async function _safeUpdate(interaction, payload) {
  try { await interaction.update(payload); }
  catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return; // expired or already acked
    log(`[SetupWizard] update failed: ${err?.message || err}`);
  }
}

async function _safeEditReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return;
    log(`[SetupWizard] reply failed: ${err?.message || err}`);
  }
}

async function _persistSetting(guildId, key, value) {
  try {
    const r = /** @type {unknown} */ (setGuildSetting(guildId, key, value));
    if (r && typeof (/** @type {any} */ (r).then) === "function") await r;
    return { ok: true };
  } catch (err) {
    log(`[SetupWizard] save failed for ${key}: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function _persistWelcomeChannel(guildId, channelId, message) {
  try {
    const r = /** @type {unknown} */ (setWelcomeChannel(guildId, channelId, message));
    if (r && typeof (/** @type {any} */ (r).then) === "function") await r;
    return { ok: true };
  } catch (err) {
    log(`[SetupWizard] save welcome failed: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function _persistLogChannel(guildId, channelId) {
  try {
    const r = /** @type {unknown} */ (setLogChannel(guildId, channelId));
    if (r && typeof (/** @type {any} */ (r).then) === "function") await r;
    return { ok: true };
  } catch (err) {
    log(`[SetupWizard] save modlog failed: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

function _checkBotChannelPerms(guild, ch) {
  const me = guild.members.me;
  if (!me || !ch) return { ok: false, reason: "bot not ready" };
  const botPerms = ch.permissionsFor?.(me);
  if (!botPerms) return { ok: false, reason: "can't check perms" };
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (!botPerms.has(needed)) {
    return { ok: false, reason: `I need View Channel + Send Messages + Embed Links in <#${ch.id}>` };
  }
  return { ok: true };
}

function _checkBotCanAssignRole(guild, role) {
  const me = guild.members.me;
  if (!me) return { ok: false, reason: "bot not ready" };
  if (role.managed) return { ok: false, reason: `**${role.name}** is managed by an integration — can't assign` };
  if (role.id === guild.id) return { ok: false, reason: `\`@everyone\` isn't an assignable role` };
  if (role.position >= me.roles.highest.position) return { ok: false, reason: `**${role.name}** is above my top role — move my role higher or pick a lower one` };
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return { ok: false, reason: "I'm missing Manage Roles" };
  return { ok: true };
}

// ─── Renderers ─────────────────────────────────────────────────────────────

function progressIcon(done) { return done ? "✅" : "⬜"; }

function _escapeGuildName(name) {
  const s = typeof name === "string" ? name : String(name || "");
  return s.replace(/[\x00-\x1f]/g, "").slice(0, 80);
}

function renderHome(guild) {
  const s = getGuildSettings(guild.id) || {};
  const rows = {
    welcome:      !!s.welcome_channel,
    modlog:       !!s.log_channel,
    automod:      !!s.antiraid_enabled || !!s.antispam_enabled,
    leveling:     s.leveling_enabled !== false,
    starboard:    !!s.starboard_channel,
    autorole:     !!s.autorole_id,
    birthday:     !!s.birthday_channel,
  };

  const desc = [
    "Pick a category to configure. Each section is optional — enable what you need.",
    "",
    `${progressIcon(rows.welcome)}  **Welcome messages**`,
    `${progressIcon(rows.modlog)}  **Mod log channel**`,
    `${progressIcon(rows.automod)}  **Auto-mod** (anti-raid + anti-spam)`,
    `${progressIcon(rows.leveling)}  **Leveling** (XP + rank roles, enabled by default)`,
    `${progressIcon(rows.starboard)}  **Starboard**`,
    `${progressIcon(rows.autorole)}  **Autorole** (role on join)`,
    `${progressIcon(rows.birthday)}  **Birthday announcements**`,
  ].join("\n");

  const embed = primaryEmbed("Setup Wizard", desc)
    .setFooter({ text: `Server: ${_escapeGuildName(guild.name)} · Click a category to configure.` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("setupwiz:welcome").setLabel("Welcome").setEmoji("👋").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("setupwiz:modlog").setLabel("Mod Log").setEmoji("📋").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("setupwiz:automod").setLabel("Auto-Mod").setEmoji("🛡️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("setupwiz:leveling").setLabel("Leveling").setEmoji("📈").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("setupwiz:starboard").setLabel("Starboard").setEmoji("⭐").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("setupwiz:autorole").setLabel("Autorole").setEmoji("🎭").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("setupwiz:birthday").setLabel("Birthdays").setEmoji("🎂").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("setupwiz:preview").setLabel("Preview").setEmoji("👁️").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2], flags: E };
}

const PAGE_KINDS = new Set(["welcome", "modlog", "automod", "leveling", "starboard", "autorole", "birthday"]);

function renderCategory(kind, guild) {
  const s = getGuildSettings(guild.id) || {};

  const pages = {
    welcome: {
      title: "Welcome Messages",
      emoji: "👋",
      status: s.welcome_channel ? `posting in <#${s.welcome_channel}>` : "*not configured*",
      description: "When someone joins, Irene posts a welcome embed in the configured channel. Pick a channel to enable.",
      picker: { type: "channel", customId: "setupwiz:welcome:pick", placeholder: "Pick welcome channel…", channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
      extraButtons: s.welcome_channel ? [
        { id: "setupwiz:welcome:clear", label: "Disable Welcome", style: ButtonStyle.Danger },
      ] : [],
    },
    modlog: {
      title: "Mod Log",
      emoji: "📋",
      status: s.log_channel ? `logging to <#${s.log_channel}>` : "*not configured — Irene will auto-detect a channel named mod-log / audit-log / logs*",
      description: "Every ban/kick/timeout/warn + channel/role changes + voice events post to the mod log.",
      picker: { type: "channel", customId: "setupwiz:modlog:pick", placeholder: "Pick mod-log channel…", channelTypes: [ChannelType.GuildText] },
      extraButtons: s.log_channel ? [
        { id: "setupwiz:modlog:clear", label: "Disable Mod Log", style: ButtonStyle.Danger },
      ] : [],
    },
    automod: {
      title: "Auto-Mod",
      emoji: "🛡️",
      status: `raid ${s.antiraid_enabled ? "✅" : "❌"} · spam ${s.antispam_enabled ? "✅" : "❌"} · mentions ${s.mentionspam_enabled ? "✅" : "❌"}`,
      description: "Anti-raid kicks in on burst joins. Anti-spam auto-warns/timeouts on rapid repeat messages. Mention-spam timeouts on mass @.",
      picker: null,
      extraButtons: [
        { id: "setupwiz:automod:toggle:antiraid", label: s.antiraid_enabled ? "Disable Anti-Raid" : "Enable Anti-Raid", style: s.antiraid_enabled ? ButtonStyle.Danger : ButtonStyle.Success },
        { id: "setupwiz:automod:toggle:antispam", label: s.antispam_enabled ? "Disable Anti-Spam" : "Enable Anti-Spam", style: s.antispam_enabled ? ButtonStyle.Danger : ButtonStyle.Success },
        { id: "setupwiz:automod:toggle:mentionspam", label: s.mentionspam_enabled ? "Disable Mention-Spam" : "Enable Mention-Spam", style: s.mentionspam_enabled ? ButtonStyle.Danger : ButtonStyle.Success },
      ],
    },
    leveling: {
      title: "Leveling",
      emoji: "📈",
      status: s.leveling_enabled === false ? "**disabled**" : "**enabled** (users gain XP from messages + voice)",
      description: "Users gain XP from chatting and being in voice channels. Configure level-up announcements and role rewards via /leveling.",
      picker: null,
      extraButtons: [
        { id: "setupwiz:leveling:toggle", label: s.leveling_enabled === false ? "Enable Leveling" : "Disable Leveling", style: s.leveling_enabled === false ? ButtonStyle.Success : ButtonStyle.Danger },
      ],
    },
    starboard: {
      title: "Starboard",
      emoji: "⭐",
      status: s.starboard_channel ? `posting to <#${s.starboard_channel}> at ${s.starboard_threshold || 3}⭐` : "*not configured*",
      description: "Messages that hit the star threshold get re-posted to the starboard channel. Pick a channel to enable.",
      picker: { type: "channel", customId: "setupwiz:starboard:pick", placeholder: "Pick starboard channel…", channelTypes: [ChannelType.GuildText] },
      extraButtons: s.starboard_channel ? [
        { id: "setupwiz:starboard:clear", label: "Disable Starboard", style: ButtonStyle.Danger },
      ] : [],
    },
    autorole: {
      title: "Autorole",
      emoji: "🎭",
      status: s.autorole_id ? `assigning <@&${s.autorole_id}> on join` : "*not configured*",
      description: "Automatically give a role to every new member when they join.",
      picker: { type: "role", customId: "setupwiz:autorole:pick", placeholder: "Pick autorole…" },
      extraButtons: s.autorole_id ? [
        { id: "setupwiz:autorole:clear", label: "Disable Autorole", style: ButtonStyle.Danger },
      ] : [],
    },
    birthday: {
      title: "Birthday Announcements",
      emoji: "🎂",
      status: s.birthday_channel ? `announcing in <#${s.birthday_channel}>` : "*not configured*",
      description: "Users register their birthday via `/birthday set`; Irene announces daily in the configured channel.",
      picker: { type: "channel", customId: "setupwiz:birthday:pick", placeholder: "Pick birthday channel…", channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
      extraButtons: s.birthday_channel ? [
        { id: "setupwiz:birthday:clear", label: "Disable Birthdays", style: ButtonStyle.Danger },
      ] : [],
    },
  };

  const page = pages[kind];
  if (!page) return renderHome(guild);

  const embed = primaryEmbed(`${page.emoji}  ${page.title}`, page.description)
    .addFields({ name: "Current Status", value: page.status })
    .setFooter({ text: "← back returns to main menu" });

  const rows = [];
  if (page.picker) {
    let picker;
    if (page.picker.type === "channel") {
      picker = new ChannelSelectMenuBuilder()
        .setCustomId(page.picker.customId)
        .setPlaceholder(page.picker.placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(page.picker.channelTypes);
    } else if (page.picker.type === "role") {
      picker = new RoleSelectMenuBuilder()
        .setCustomId(page.picker.customId)
        .setPlaceholder(page.picker.placeholder)
        .setMinValues(1)
        .setMaxValues(1);
    }
    rows.push(new ActionRowBuilder().addComponents(/** @type {any} */ (picker)));
  }
  if (page.extraButtons?.length) {
    rows.push(new ActionRowBuilder().addComponents(
      ...page.extraButtons.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.style))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("setupwiz:home").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [embed], components: rows, flags: E };
}

function renderPreview(guild) {
  const s = getGuildSettings(guild.id) || {};
  const items = [
    s.welcome_channel ? `👋 Welcome → <#${s.welcome_channel}>` : "👋 Welcome — *off*",
    s.log_channel ? `📋 Mod log → <#${s.log_channel}>` : "📋 Mod log — *off (will auto-detect)*",
    `🛡️ Anti-raid — ${s.antiraid_enabled ? "✅" : "❌"} · Anti-spam — ${s.antispam_enabled ? "✅" : "❌"} · Mention-spam — ${s.mentionspam_enabled ? "✅" : "❌"}`,
    `📈 Leveling — ${s.leveling_enabled === false ? "❌" : "✅"}`,
    s.starboard_channel ? `⭐ Starboard → <#${s.starboard_channel}> at ${s.starboard_threshold || 3}⭐` : "⭐ Starboard — *off*",
    s.autorole_id ? `🎭 Autorole → <@&${s.autorole_id}>` : "🎭 Autorole — *off*",
    s.birthday_channel ? `🎂 Birthdays → <#${s.birthday_channel}>` : "🎂 Birthdays — *off*",
  ];
  const embed = infoEmbed("Configuration Preview", items.join("\n")).setFooter({ text: `Server: ${_escapeGuildName(guild.name)}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("setupwiz:home").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], flags: E };
}

// ─── Interaction handler (dispatched from events/interactionCreate.js) ─────

export async function handleSetupWizard(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "setup controls only work in a server", flags: E }).catch(() => {});
  }
  const member = await _ensureMember(interaction);
  if (!_hasManageGuild(member)) {
    return interaction.reply({ content: "only admins can use setup wizard controls", flags: E }).catch(() => {});
  }

  const parts = (interaction.customId || "").split(":");
  if (parts[0] !== "setupwiz") return;
  const page = parts[1];
  const action = parts[2];
  const sub = parts[3];
  const guild = interaction.guild;

  // ── Navigation only (no action) ────────────────────────────────────────
  if (!action) {
    const payload = page === "home" ? renderHome(guild)
                  : page === "preview" ? renderPreview(guild)
                  : (PAGE_KINDS.has(page) ? renderCategory(page, guild) : renderHome(guild));
    return _safeUpdate(interaction, payload);
  }

  // Defense in depth — unknown page with action
  if (!PAGE_KINDS.has(page)) return _safeUpdate(interaction, renderHome(guild));

  // ── Channel / role pickers ─────────────────────────────────────────────
  if (action === "pick") {
    if (page === "welcome" || page === "modlog" || page === "starboard" || page === "birthday") {
      const ch = interaction.channels?.first?.() ?? guild.channels.cache.get(interaction.values?.[0]);
      if (!ch) return interaction.reply({ content: "couldn't resolve that channel — try again", flags: E }).catch(() => {});
      if (ch.guild?.id && ch.guild.id !== guild.id) {
        return interaction.reply({ content: "channel must be in this server", flags: E }).catch(() => {});
      }
      const botCheck = _checkBotChannelPerms(guild, ch);
      if (!botCheck.ok) return interaction.reply({ content: botCheck.reason, flags: E }).catch(() => {});

      let saved;
      if (page === "welcome") saved = await _persistWelcomeChannel(guild.id, ch.id, null);
      else if (page === "modlog") saved = await _persistLogChannel(guild.id, ch.id);
      else if (page === "starboard") {
        saved = await _persistSetting(guild.id, "starboard_channel", ch.id);
        const s = getGuildSettings(guild.id) || {};
        if (saved.ok && !s.starboard_threshold) await _persistSetting(guild.id, "starboard_threshold", 3);
      }
      else saved = await _persistSetting(guild.id, "birthday_channel", ch.id);

      if (!saved.ok) return interaction.reply({ embeds: [errorEmbed("Save failed", saved.error)], flags: E }).catch(() => {});
      log(`[Setup] ${page} channel set to ${ch.name} in ${guild.name}`);
      return _safeUpdate(interaction, renderCategory(page, guild));
    }

    if (page === "autorole") {
      const role = interaction.roles?.first?.() ?? guild.roles.cache.get(interaction.values?.[0]);
      if (!role) return interaction.reply({ content: "couldn't resolve that role — try again", flags: E }).catch(() => {});
      const check = _checkBotCanAssignRole(guild, role);
      if (!check.ok) return interaction.reply({ content: check.reason, flags: E }).catch(() => {});
      const roleErr = validateAssignableRole(guild, role, { actor: interaction.member, actionLabel: "Autorole" });
      if (roleErr) return interaction.reply({ content: roleErr, flags: E }).catch(() => {});
      const saved = await _persistSetting(guild.id, "autorole_id", role.id);
      if (!saved.ok) return interaction.reply({ embeds: [errorEmbed("Save failed", saved.error)], flags: E }).catch(() => {});
      return _safeUpdate(interaction, renderCategory(page, guild));
    }

    // Unknown pick target — refresh category
    return _safeUpdate(interaction, renderCategory(page, guild));
  }

  // ── Clears ─────────────────────────────────────────────────────────────
  if (action === "clear") {
    const clearKey = {
      welcome: "welcome_channel",
      modlog: "log_channel",
      starboard: "starboard_channel",
      autorole: "autorole_id",
      birthday: "birthday_channel",
    }[page];
    if (clearKey) {
      const saved = await _persistSetting(guild.id, clearKey, null);
      if (!saved.ok) return interaction.reply({ embeds: [errorEmbed("Save failed", saved.error)], flags: E }).catch(() => {});
    }
    return _safeUpdate(interaction, renderCategory(page, guild));
  }

  // ── Toggles ────────────────────────────────────────────────────────────
  if (action === "toggle") {
    const s = getGuildSettings(guild.id) || {};
    if (page === "automod") {
      const keyMap = { antiraid: "antiraid_enabled", antispam: "antispam_enabled", mentionspam: "mentionspam_enabled" };
      const key = keyMap[sub];
      if (!key) return _safeUpdate(interaction, renderCategory(page, guild));
      const saved = await _persistSetting(guild.id, key, !s[key]);
      if (!saved.ok) return interaction.reply({ embeds: [errorEmbed("Save failed", saved.error)], flags: E }).catch(() => {});
    } else if (page === "leveling") {
      const current = s.leveling_enabled !== false;
      const saved = await _persistSetting(guild.id, "leveling_enabled", !current);
      if (!saved.ok) return interaction.reply({ embeds: [errorEmbed("Save failed", saved.error)], flags: E }).catch(() => {});
    }
    return _safeUpdate(interaction, renderCategory(page, guild));
  }

  return _safeUpdate(interaction, renderHome(guild));
}
