import { SlashCommandBuilder } from "discord.js";
import { successEmbed, infoEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";

// ── AFK Store ──────────────────────────────────────────────────────────────────
// Key: `guildId-userId`, Value: { reason, timestamp }
const afkUsers = new Map();

// ── Utility Functions ──────────────────────────────────────────────────────────

export function setAfkStatus(guildId, userId, reason = "AFK") {
  const key = `${guildId}-${userId}`;
  afkUsers.set(key, { reason, timestamp: Date.now() });
  log(`[AFK] ${userId} is now AFK in guild ${guildId}: ${reason}`);
}

export function clearAfk(guildId, userId) {
  const key = `${guildId}-${userId}`;
  const hadStatus = afkUsers.has(key);
  if (hadStatus) {
    afkUsers.delete(key);
    log(`[AFK] ${userId} is no longer AFK in guild ${guildId}`);
  }
  return hadStatus;
}

export function getAfk(guildId, userId) {
  const key = `${guildId}-${userId}`;
  return afkUsers.get(key) || null;
}

// ── Format time elapsed ────────────────────────────────────────────────────────
function formatTimeAgo(timestamp) {
  const now = Date.now();
  const elapsed = now - timestamp;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return `${seconds}s ago`;
}

// ── Check for AFK mentions ─────────────────────────────────────────────────────
// Scans mentioned users and replies with their AFK status
export function checkAfkMentions(message) {
  if (!message.mentions || message.mentions.size === 0) return;

  const embeds = [];
  message.mentions.users.forEach((user) => {
    const afkStatus = getAfk(message.guild.id, user.id);
    if (afkStatus) {
      const timeAgo = formatTimeAgo(afkStatus.timestamp);
      const afkDate = new Date(afkStatus.timestamp).toLocaleString();
      const embed = infoEmbed(
        `${user.username} is AFK`,
        afkStatus.reason
      )
        .addFields(
          { name: "Status", value: "Away from Keyboard", inline: true },
          { name: "Since", value: afkDate, inline: true },
          { name: "Time Elapsed", value: timeAgo, inline: true }
        );
      embeds.push(embed);
    }
  });

  if (embeds.length > 0) {
    message.reply({ embeds, flags: 64 }).catch(() => {});
  }
}

// ── Check if author is returning from AFK ──────────────────────────────────────
// If message author has AFK status, clear it and notify
export function checkAfkReturn(message) {
  if (!message.author || message.author.bot) return;

  if (clearAfk(message.guild.id, message.author.id)) {
    message.reply({
      content: `welcome back ${message.author}, removed your AFK`,
      flags: 64,
    }).catch(() => {});
  }
}

// ── Command ────────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("afk")
  .setDescription("Set your AFK status with an optional reason")
  .addStringOption((o) =>
    o.setName("reason")
      .setDescription("Why you're AFK")
      .setRequired(false)
      .setMaxLength(200)
  );

export async function execute(interaction) {
  const reason = interaction.options.getString("reason") || "AFK";

  setAfkStatus(interaction.guild.id, interaction.user.id, reason);

  await interaction.reply({
    embeds: [
      successEmbed("AFK Status Set", `you're now AFK: ${reason}`)
    ],
    flags: 64,
  });
}

// ── Export for database integration ────────────────────────────────────────────

export function initAfkData(loaded) {
  if (loaded && loaded.afk_users) {
    afkUsers.clear();
    Object.entries(loaded.afk_users).forEach(([key, value]) => {
      afkUsers.set(key, value);
    });
    log(`[AFK] Loaded ${afkUsers.size} AFK statuses from database`);
  }
}

export function getAfkData() {
  const result = {};
  afkUsers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
