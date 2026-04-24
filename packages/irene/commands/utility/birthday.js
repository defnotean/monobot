import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import {
  setBirthday, removeBirthday, getBirthday, getGuildBirthdays,
  getBirthdayConfig, setBirthdayChannel, setBirthdayRole, setBirthdayMessage,
} from "../../database.js";

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const data = new SlashCommandBuilder()
  .setName("birthday")
  .setDescription("Birthday system — set yours, view others, check upcoming")
  .addSubcommand((s) => s
    .setName("set")
    .setDescription("Set your birthday")
    .addIntegerOption((o) => o.setName("month").setDescription("Month number (1–12)").setRequired(true).setMinValue(1).setMaxValue(12))
    .addIntegerOption((o) => o.setName("day").setDescription("Day of month").setRequired(true).setMinValue(1).setMaxValue(31))
    .addIntegerOption((o) => o.setName("year").setDescription("Birth year (e.g. 2001) — optional, lets us show your age").setMinValue(1900).setMaxValue(new Date().getFullYear()))
  )
  .addSubcommand((s) => s
    .setName("view")
    .setDescription("View a member's birthday")
    .addUserOption((o) => o.setName("user").setDescription("Whose birthday to view (defaults to yours)"))
  )
  .addSubcommand((s) => s
    .setName("list")
    .setDescription("See all upcoming birthdays in this server")
  )
  .addSubcommand((s) => s
    .setName("remove")
    .setDescription("Remove your birthday from this server")
  )
  .addSubcommand((s) => s
    .setName("setup")
    .setDescription("Configure birthday announcements (admin only)")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel where birthday messages are posted").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role to give someone on their birthday for 24 h (optional)"))
    .addStringOption((o) => o.setName("message").setDescription("Custom message — supports {user}, {username}, {server}"))
  )
  .addSubcommand((s) => s
    .setName("config")
    .setDescription("View current birthday configuration")
  );

export async function execute(interaction) {
  const sub   = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const userId = interaction.user.id;

  // ── set ──────────────────────────────────────────────────────────────────────
  if (sub === "set") {
    const month = interaction.options.getInteger("month");
    const day   = interaction.options.getInteger("day");

    if (day > DAYS_IN_MONTH[month]) {
      return interaction.reply({
        content: `❌ ${MONTHS[month - 1]} only has ${DAYS_IN_MONTH[month]} days — double check your date!`,
        ephemeral: true,
      });
    }

    const year = interaction.options.getInteger("year") ?? null;
    setBirthday(userId, guild.id, month, day, year);
    const dateStr = year ? `**${MONTHS[month - 1]} ${day}, ${year}**` : `**${MONTHS[month - 1]} ${day}**`;
    return interaction.reply({
      content: `✅ Birthday set to ${dateStr}! I'll announce it when your day comes 🎂`,
      ephemeral: true,
    });
  }

  // ── view ─────────────────────────────────────────────────────────────────────
  if (sub === "view") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const bday   = getBirthday(target.id, guild.id);
    if (!bday) {
      return interaction.reply({
        content: `${target.id === userId ? "You haven't" : `**${target.username}** hasn't`} set a birthday yet.`,
        ephemeral: true,
      });
    }

    // Days until
    const today = new Date();
    const bDate = new Date(today.getFullYear(), bday.month - 1, bday.day);
    if (bDate < today) bDate.setFullYear(today.getFullYear() + 1);
    const daysLeft = Math.ceil((bDate - today) / 86_400_000);
    const label = daysLeft === 0 ? "🎉 **Today!**" : daysLeft === 1 ? "tomorrow!" : `in **${daysLeft}** days`;

    return interaction.reply({
      content: `🎂 **${target.username}**'s birthday is **${MONTHS[bday.month - 1]} ${bday.day}** — ${label}`,
      ephemeral: true,
    });
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const all = getGuildBirthdays(guild.id);
    if (!all.length) {
      return interaction.reply({ content: "No birthdays set in this server yet. Members can use `/birthday set` to add theirs!", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const today = new Date();
    function daysUntil(month, day) {
      const bDate = new Date(today.getFullYear(), month - 1, day);
      if (bDate < today) bDate.setFullYear(today.getFullYear() + 1);
      return Math.ceil((bDate - today) / 86_400_000);
    }

    const sorted = [...all].sort((a, b) => daysUntil(a.month, a.day) - daysUntil(b.month, b.day));

    const lines = await Promise.all(
      sorted.slice(0, 25).map(async (b) => {
        const member = guild.members.cache.get(b.userId)
          ?? await guild.members.fetch(b.userId).catch(() => null);
        const name   = member?.displayName ?? `<@${b.userId}>`;
        const days   = daysUntil(b.month, b.day);
        const when   = days === 0 ? "🎉 today!" : days === 1 ? "tomorrow" : `in ${days}d`;
        return `**${name}** — ${MONTHS[b.month - 1]} ${b.day}  *(${when})*`;
      })
    );

    const embed = new EmbedBuilder()
      .setColor(0xFF73FA)
      .setTitle("🎂 Upcoming Birthdays")
      .setDescription(lines.join("\n"))
      .setFooter({ text: `${all.length} birthday${all.length !== 1 ? "s" : ""} registered in ${guild.name}` });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── remove ───────────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const removed = removeBirthday(userId, guild.id);
    return interaction.reply({
      content: removed ? "✅ Your birthday has been removed." : "You don't have a birthday set in this server.",
      ephemeral: true,
    });
  }

  // ── setup ────────────────────────────────────────────────────────────────────
  if (sub === "setup") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You need **Manage Server** permission to configure birthdays.", ephemeral: true });
    }

    const channel = interaction.options.getChannel("channel");
    const role    = interaction.options.getRole("role");
    const message = interaction.options.getString("message");

    setBirthdayChannel(guild.id, channel.id);
    if (role)    setBirthdayRole(guild.id, role.id);
    if (message) setBirthdayMessage(guild.id, message);

    const lines = [`✅ Birthday announcements set to ${channel}`];
    if (role)    lines.push(`🎭 Birthday role: ${role} *(given for 24 h)*`);
    if (message) lines.push(`💬 Custom message saved`);
    lines.push(`\nMembers can now use \`/birthday set\` to register!`);

    return interaction.reply({ content: lines.join("\n"), ephemeral: true });
  }

  // ── config ───────────────────────────────────────────────────────────────────
  if (sub === "config") {
    const cfg = getBirthdayConfig(guild.id);
    const channel = cfg.channel_id ? `<#${cfg.channel_id}>` : "*not set*";
    const role    = cfg.role_id    ? `<@&${cfg.role_id}>` : "*none*";
    const count   = getGuildBirthdays(guild.id).length;

    const embed = new EmbedBuilder()
      .setColor(0xFF73FA)
      .setTitle("🎂 Birthday Config")
      .addFields(
        { name: "Announcement Channel", value: channel,              inline: true },
        { name: "Birthday Role",        value: role,                 inline: true },
        { name: "Registered Birthdays", value: String(count),        inline: true },
        { name: "Announcement Message", value: (cfg.message ?? "").slice(0, 200) || "*not set*", inline: false },
      )
      .setFooter({ text: "Use /birthday setup to change these settings" });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
