// ─── Birthday Announcement System ────────────────────────────────────────────
// Shared embed builder + hourly checker that announces birthdays and assigns roles.

import { EmbedBuilder } from "discord.js";
import { getTodaysBirthdays, getBirthdayConfig, markBirthdayAnnounced, wasBirthdayAnnounced, getBirthday } from "../database.js";
import { log } from "./logger.js";

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Shared birthday embed builder ──────────────────────────────────────────
/**
 * Builds a birthday announcement embed for a member.
 * @param {object} options.bday — the birthday record { month, day, year? } (optional, for age display)
 * Returns { embed, pingContent }.
 */
export function buildBirthdayEmbed(member, config, bday) {
  // Calculate real-world age if birth year is known
  let turningAge = null;
  if (bday?.year) {
    const today = new Date();
    turningAge = today.getFullYear() - bday.year;
    // If birthday hasn't happened yet this year, they haven't turned yet
    if (today.getMonth() + 1 < bday.month || (today.getMonth() + 1 === bday.month && today.getDate() < bday.day)) {
      turningAge--;
    }
  }

  const ageStr = turningAge !== null ? ` They're turning **${turningAge}** today!` : "";

  const msg = ((config?.message ?? "🎂 Happy Birthday {user}! Wishing you an amazing day — you deserve it! 🎉") + ageStr)
    .replace(/{user}/g,     member.toString())
    .replace(/{username}/g, member.displayName)
    .replace(/{server}/g,   member.guild.name)
    .replace(/{age}/g,      turningAge !== null ? String(turningAge) : "");

  const avatar   = member.user.displayAvatarURL({ size: 512 });
  const guildIcon = member.guild.iconURL({ size: 128 });

  // Calculate age on Discord
  const createdTs = member.user.createdTimestamp;
  const ageDays   = Math.floor((Date.now() - createdTs) / 86_400_000);
  const years     = Math.floor(ageDays / 365);
  const months    = Math.floor((ageDays % 365) / 30);
  const discordAge = years >= 1
    ? (months > 0 ? `${years}y ${months}mo` : `${years}y`)
    : (ageDays < 30 ? `${ageDays}d` : `${months}mo`);

  // Member's top role color, or festive pink fallback
  const roleColor = member.displayColor !== 0 ? member.displayColor : 0xFF73FA;

  const titleText = turningAge !== null
    ? `🎂 Happy ${turningAge}${ordinal(turningAge)} Birthday, ${member.displayName}!`
    : `🎂 Happy Birthday, ${member.displayName}!`;

  const embed = new EmbedBuilder()
    .setColor(roleColor)
    .setAuthor({ name: `🎉 ${member.guild.name}`, iconURL: guildIcon ?? undefined })
    .setTitle(titleText)
    .setDescription(msg)
    .setThumbnail(avatar);

  const fields = [];
  if (turningAge !== null) fields.push({ name: "🎈 Turning", value: `**${turningAge}** years old`, inline: true });
  fields.push({ name: "🕐 On Discord", value: discordAge, inline: true });
  fields.push({ name: "🔢 Member", value: `#${member.guild.memberCount}`, inline: true });
  embed.addFields(...fields);

  embed
    .setFooter({ text: "Wish them a happy birthday! 🥳", iconURL: guildIcon ?? undefined })
    .setTimestamp();

  return { embed, pingContent: member.toString() };
}

// ─── Hourly checker ─────────────────────────────────────────────────────────

export async function checkBirthdays(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await checkGuildBirthdays(guild);
    } catch (err) {
      log(`[Birthday] Error checking ${guild.name}: ${err.message}`);
    }
  }
}

async function checkGuildBirthdays(guild) {
  const config = getBirthdayConfig(guild.id);
  if (!config.channel_id) return;

  const channel = guild.channels.cache.get(config.channel_id)
    ?? await guild.channels.fetch(config.channel_id).catch(() => null);
  if (!channel) return;

  const birthdays = getTodaysBirthdays(guild.id);
  for (const bday of birthdays) {
    if (wasBirthdayAnnounced(bday.userId, guild.id)) continue;

    const member = guild.members.cache.get(bday.userId)
      ?? await guild.members.fetch(bday.userId).catch(() => null);
    if (!member) continue;

    const { embed, pingContent } = buildBirthdayEmbed(member, config, bday);

    await channel.send({ content: pingContent, embeds: [embed] });
    markBirthdayAnnounced(bday.userId, guild.id);
    log(`[Birthday] 🎂 ${member.user.tag} in "${guild.name}"`);

    // Assign birthday role for 24 hours if configured
    if (config.role_id) {
      const role = guild.roles.cache.get(config.role_id);
      if (role) {
        await member.roles.add(role, "Birthday role").catch(() => {});
        setTimeout(async () => {
          try {
            const freshMember = await guild.members.fetch(member.id).catch(() => null);
            if (freshMember) await freshMember.roles.remove(role, "Birthday role expired").catch(() => {});
          } catch {}
        }, 24 * 60 * 60_000);
      }
    }
  }
}
