// /bumpconfig — configure the bump reminder system
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { getGuildSettings, setGuildSetting } from "../../database.js";

const SERVICE_CHOICES = [
  { name: "DISBOARD", value: "disboard" },
  { name: "Discadia", value: "discadia" },
  { name: "Disforge", value: "disforge" },
  { name: "DiscordServers.com", value: "discordservers" },
];

export const data = new SlashCommandBuilder()
  .setName("bumpconfig")
  .setDescription("Configure the bump reminder")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup(g => g
    .setName("role").setDescription("Manage which roles get pinged")
    .addSubcommand(s => s.setName("add").setDescription("Add a role to the ping list")
      .addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Remove a role from the ping list")
      .addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand(s => s.setName("clear").setDescription("Clear all ping roles"))
    .addSubcommand(s => s.setName("rotation")
      .setDescription("How to ping when multiple roles are configured")
      .addStringOption(o => o.setName("mode").setDescription("Rotation mode").setRequired(true)
        .addChoices(
          { name: "all — ping every role every time (default)", value: "all" },
          { name: "rotate — round-robin one role per ping", value: "rotate" },
          { name: "online — only ping roles with online members", value: "online" },
        )))
  )
  .addSubcommandGroup(g => g
    .setName("service").setDescription("Enable or disable bump services")
    .addSubcommand(s => s.setName("enable").setDescription("Enable a bump service on this server")
      .addStringOption(o => o.setName("which").setDescription("Service").setRequired(true).addChoices(...SERVICE_CHOICES)))
    .addSubcommand(s => s.setName("disable").setDescription("Disable a bump service on this server")
      .addStringOption(o => o.setName("which").setDescription("Service").setRequired(true).addChoices(...SERVICE_CHOICES)))
  )
  .addSubcommand(s => s.setName("channel")
    .setDescription("Send reminders to a different channel than the bump channel")
    .addChannelOption(o => o.setName("channel").setDescription("Channel, or leave empty to reset").setRequired(false)))
  .addSubcommand(s => s.setName("quiet")
    .setDescription("Set quiet hours when pings are suppressed")
    .addIntegerOption(o => o.setName("start_hour").setDescription("0-23").setMinValue(0).setMaxValue(23).setRequired(true))
    .addIntegerOption(o => o.setName("end_hour").setDescription("0-23").setMinValue(0).setMaxValue(23).setRequired(true))
    .addStringOption(o => o.setName("timezone").setDescription("e.g. America/Los_Angeles — defaults to UTC")))
  .addSubcommand(s => s.setName("unquiet").setDescription("Disable quiet hours"))
  .addSubcommand(s => s.setName("template")
    .setDescription("Set a custom reminder message (overrides AI voice). Use {service} {command} {guildName}. Empty = AI voice.")
    .addStringOption(o => o.setName("text").setDescription("Template text (leave empty to clear)")))
  .addSubcommand(s => s.setName("no_show_toggle")
    .setDescription("Toggle the 15-minute no-show escalation nudge")
    .addBooleanOption(o => o.setName("enabled").setDescription("true = escalate, false = quiet").setRequired(true)))
  .addSubcommand(s => s.setName("applause")
    .setDescription("Toggle the post-bump applause shoutout (default: on)")
    .addBooleanOption(o => o.setName("enabled").setDescription("true = applaud bumpers, false = silent").setRequired(true)))
  .addSubcommand(s => s.setName("personal_ping")
    .setDescription("Allow users to opt into personal DM bump pings on this server (default: off)")
    .addBooleanOption(o => o.setName("enabled").setDescription("true = allow DMs, false = disable feature").setRequired(true)))
  .addSubcommand(s => s.setName("mvp")
    .setDescription("Toggle the weekly MVP thank-you DM sent to the server's top bumper (default: on)")
    .addBooleanOption(o => o.setName("enabled").setDescription("true = send weekly MVP, false = skip").setRequired(true)))
  .addSubcommand(s => s.setName("celebration_template")
    .setDescription("Customize milestone/goal-hit/fell-short/streak-lost messages. Empty text clears the override.")
    .addStringOption(o => o.setName("category").setDescription("Which template to set").setRequired(true).addChoices(
      { name: "milestone — streak milestone celebration", value: "milestone" },
      { name: "goal_hit — bump-a-thon goal hit", value: "goal_hit" },
      { name: "fell_short — bump-a-thon expired without goal", value: "fell_short" },
      { name: "streak_lost — prepended when a streak breaks", value: "streak_lost" },
    ))
    .addStringOption(o => o.setName("text").setDescription("Template text (vars: {streak} {goal} {progress} {short} {duration_hours} {mvp}). Empty to clear.")))
  .addSubcommand(s => s.setName("show").setDescription("Show current configuration"));

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  const guildId = interaction.guild.id;
  const group = interaction.options.getSubcommandGroup(false);
  const sub   = interaction.options.getSubcommand();
  const settings = getGuildSettings(guildId) || {};

  // ─── role group ────────────────────────────────────────────────────────
  if (group === "role") {
    let roles = Array.isArray(settings.bump_ping_roles) ? [...settings.bump_ping_roles] : [];
    if (sub === "add") {
      const role = interaction.options.getRole("role");
      if (roles.includes(role.id)) return interaction.reply({ content: `<@&${role.id}> is already in the list`, ephemeral: true });
      roles.push(role.id);
      setGuildSetting(guildId, "bump_ping_roles", roles);
      return interaction.reply({ content: `✅ <@&${role.id}> added`, ephemeral: true });
    }
    if (sub === "remove") {
      const role = interaction.options.getRole("role");
      const before = roles.length;
      roles = roles.filter(id => id !== role.id);
      if (roles.length === before) return interaction.reply({ content: `<@&${role.id}> wasn't in the list`, ephemeral: true });
      setGuildSetting(guildId, "bump_ping_roles", roles);
      return interaction.reply({ content: `✅ <@&${role.id}> removed`, ephemeral: true });
    }
    if (sub === "clear") {
      setGuildSetting(guildId, "bump_ping_roles", []);
      return interaction.reply({ content: "✅ cleared all ping roles", ephemeral: true });
    }
    if (sub === "rotation") {
      const mode = interaction.options.getString("mode");
      setGuildSetting(guildId, "bump_rotation_mode", mode);
      return interaction.reply({ content: `✅ rotation mode: ${mode}`, ephemeral: true });
    }
  }

  // ─── service group ─────────────────────────────────────────────────────
  if (group === "service") {
    const which = interaction.options.getString("which");
    const enabled = Array.isArray(settings.bump_enabled_services)
      ? [...settings.bump_enabled_services]
      : ["disboard"];

    if (sub === "enable") {
      if (!enabled.includes(which)) enabled.push(which);
      setGuildSetting(guildId, "bump_enabled_services", enabled);
      return interaction.reply({ content: `✅ ${which} enabled on this server`, ephemeral: true });
    }
    if (sub === "disable") {
      const next = enabled.filter(s => s !== which);
      setGuildSetting(guildId, "bump_enabled_services", next);
      return interaction.reply({ content: `✅ ${which} disabled on this server`, ephemeral: true });
    }
  }

  // ─── standalone subcommands ────────────────────────────────────────────

  if (sub === "channel") {
    const channel = interaction.options.getChannel("channel");
    if (!channel) {
      setGuildSetting(guildId, "bump_reminder_channel_id", null);
      return interaction.reply({ content: "✅ reminder channel cleared — reminders go to the bump channel again", ephemeral: true });
    }
    if (!channel.isTextBased?.()) return interaction.reply({ content: "pick a text channel", ephemeral: true });
    setGuildSetting(guildId, "bump_reminder_channel_id", channel.id);
    return interaction.reply({ content: `✅ reminders will now be sent to <#${channel.id}>`, ephemeral: true });
  }

  if (sub === "quiet") {
    const start = interaction.options.getInteger("start_hour");
    const end = interaction.options.getInteger("end_hour");
    const tz = interaction.options.getString("timezone") || "UTC";
    try {
      // Validate the timezone by attempting to format with it.
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return interaction.reply({ content: `invalid timezone "${tz}" — use IANA format like America/Los_Angeles`, ephemeral: true });
    }
    setGuildSetting(guildId, "bump_quiet_hours", { start, end, tz });
    return interaction.reply({
      content: `✅ quiet hours set: ${start}:00 → ${end}:00 (${tz}). during this window the reminder fires silently without pinging roles.`,
      ephemeral: true,
    });
  }

  if (sub === "unquiet") {
    setGuildSetting(guildId, "bump_quiet_hours", null);
    setGuildSetting(guildId, "bump_quiet_until", null);
    return interaction.reply({ content: "✅ quiet hours disabled", ephemeral: true });
  }

  if (sub === "template") {
    const text = interaction.options.getString("text");
    if (!text) {
      setGuildSetting(guildId, "bump_template", null);
      return interaction.reply({ content: "✅ custom template cleared — reminders use AI voice again", ephemeral: true });
    }
    setGuildSetting(guildId, "bump_template", text.slice(0, 500));
    return interaction.reply({ content: `✅ template saved. preview:\n\n${renderPreview(text, interaction.guild.name)}`, ephemeral: true });
  }

  if (sub === "no_show_toggle") {
    const enabled = interaction.options.getBoolean("enabled");
    setGuildSetting(guildId, "bump_no_show_escalate", enabled);
    return interaction.reply({ content: `✅ no-show escalation ${enabled ? "enabled" : "disabled"}`, ephemeral: true });
  }

  if (sub === "applause") {
    const enabled = interaction.options.getBoolean("enabled");
    setGuildSetting(guildId, "bump_applause_enabled", enabled);
    return interaction.reply({
      content: enabled
        ? "✅ bump applause on — i'll shout out every bumper 🩵"
        : "✅ bump applause off — bumps will be logged silently",
      ephemeral: true,
    });
  }

  if (sub === "personal_ping") {
    const enabled = interaction.options.getBoolean("enabled");
    setGuildSetting(guildId, "bump_personal_ping_enabled", enabled);
    return interaction.reply({
      content: enabled
        ? "✅ personal DM pings are now available on this server. users opt in individually via `/bumps dm on`."
        : "✅ personal DM pings disabled on this server.",
      ephemeral: true,
    });
  }

  if (sub === "mvp") {
    const enabled = interaction.options.getBoolean("enabled");
    setGuildSetting(guildId, "bump_mvp_enabled", enabled);
    return interaction.reply({
      content: enabled
        ? "✅ weekly MVP DM on — the top bumper gets a thank-you each Sunday 🩵"
        : "✅ weekly MVP DM off",
      ephemeral: true,
    });
  }

  if (sub === "celebration_template") {
    const category = interaction.options.getString("category");
    const text = interaction.options.getString("text") || "";
    const tpls = { ...(getGuildSettings(guildId)?.bump_celebration_templates || {}) };
    if (!text.trim()) {
      delete tpls[category];
      setGuildSetting(guildId, "bump_celebration_templates", Object.keys(tpls).length ? tpls : null);
      return interaction.reply({
        content: `✅ cleared custom template for \`${category}\` — defaults apply again.`,
        ephemeral: true,
      });
    }
    tpls[category] = text.slice(0, 500);
    setGuildSetting(guildId, "bump_celebration_templates", tpls);
    const sample = { streak: 30, goal: 10, progress: 7, short: 3, duration_hours: 12, mvp: "@toyou", service: "disboard" };
    const preview = text.replace(/\{(\w+)\}/g, (_, k) => (sample[k] != null ? String(sample[k]) : `{${k}}`));
    return interaction.reply({
      content: `✅ saved custom template for \`${category}\`.\n\n**Preview:**\n${preview.slice(0, 1500)}`,
      ephemeral: true,
    });
  }

  if (sub === "show") {
    const s = getGuildSettings(guildId) || {};
    const roles = s.bump_ping_roles?.length ? s.bump_ping_roles.map(id => `<@&${id}>`).join(", ") : "none";
    const services = Array.isArray(s.bump_enabled_services) ? s.bump_enabled_services.join(", ") : "disboard (default)";
    const channel = s.bump_reminder_channel_id ? `<#${s.bump_reminder_channel_id}>` : "bump channel (auto-detected)";
    const quiet = s.bump_quiet_hours
      ? `${s.bump_quiet_hours.start}:00 → ${s.bump_quiet_hours.end}:00 (${s.bump_quiet_hours.tz || "UTC"})`
      : "off";
    const rotation = s.bump_rotation_mode || "all";
    const template = s.bump_template ? "custom template set" : "AI voice (default)";
    const escalate = s.bump_no_show_escalate === false ? "off" : "on (15m)";
    const applause = s.bump_applause_enabled === false ? "off" : "on";
    const personalPing = s.bump_personal_ping_enabled === true ? "on" : "off (default)";
    const mvp = s.bump_mvp_enabled === false ? "off" : "on";
    const celebTpls = s.bump_celebration_templates || {};
    const celebSet = Object.keys(celebTpls).length
      ? Object.keys(celebTpls).join(", ")
      : "none (defaults)";

    const embed = new EmbedBuilder()
      .setColor(0x9333EA)
      .setTitle("Bump config · " + interaction.guild.name)
      .addFields(
        { name: "Ping roles", value: roles, inline: false },
        { name: "Rotation mode", value: rotation, inline: true },
        { name: "Services", value: services, inline: true },
        { name: "Channel", value: channel, inline: true },
        { name: "Quiet hours", value: quiet, inline: true },
        { name: "No-show escalate", value: escalate, inline: true },
        { name: "Reminder text", value: template, inline: true },
        { name: "Post-bump applause", value: applause, inline: true },
        { name: "Personal DM pings", value: personalPing, inline: true },
        { name: "Weekly MVP DM", value: mvp, inline: true },
        { name: "Celebration templates", value: celebSet, inline: false },
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

function renderPreview(tpl, guildName) {
  return tpl
    .replace(/\{guildName\}/g, guildName)
    .replace(/\{service\}/g, "DISBOARD")
    .replace(/\{command\}/g, "/bump");
}
