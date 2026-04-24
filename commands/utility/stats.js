import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";

const aiStats = new Map(); // guildId → { date, count }

// Cache for stats (guildId → { timestamp, data })
const statsCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show server activity dashboard");

export async function execute(interaction) {
  const guild = interaction.guild;
  const guildId = guild.id;

  // Check cache
  const cached = statsCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const embed = cached.data;
    if (guild.icon) embed.setThumbnail(guild.iconURL({ size: 512 }));
    await interaction.reply({
      embeds: [embed],
      flags: 64,
    }).catch(() => {});
    return;
  }

  // Get member counts
  await guild.members.fetch({ limit: 0 }).catch(() => {});
  const totalMembers = guild.memberCount || 0;
  const onlineMembers = guild.members.cache.filter((m) => m.presence?.status !== "offline").size;

  // Get boost info
  const boostLevel = guild.premiumTier;
  const boostCount = guild.premiumSubscriptionCount || 0;

  // Get channel and role counts
  const channelCount = guild.channels.cache.size;
  const roleCount = guild.roles.cache.size;

  // Get server created date
  const createdDate = guild.createdAt.toLocaleDateString();

  // Get voice activity
  let voiceUsers = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.isVoiceBased()) {
      voiceUsers += channel.members?.size || 0;
    }
  }

  // Get bot uptime
  const uptime = interaction.client.uptime;
  const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
  const uptimeStr = `${uptimeHours}h ${uptimeMinutes}m`;

  // Get most active channel (by recent messages if available)
  let mostActiveChannel = "unknown";
  try {
    let topChannel = null;
    let topCount = 0;
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased()) continue;
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (messages && messages.size > topCount) {
        topCount = messages.size;
        topChannel = channel;
      }
    }
    if (topChannel) mostActiveChannel = topChannel.name;
  } catch (err) {
    log(`[Stats] Error fetching channel messages: ${err.message}`);
  }

  // Get AI stats
  const aiData = getAiStats(guildId);

  // Build embed with fields for better formatting
  const embed = primaryEmbed(`${guild.name} Stats`, "Server statistics and information")
    .addFields(
      { name: "Members", value: `${totalMembers} total\n${onlineMembers} online`, inline: true },
      { name: "Boosts", value: `Level ${boostLevel}\n${boostCount} boosts`, inline: true },
      { name: "Channels", value: `${channelCount} channels`, inline: true },
      { name: "Roles", value: `${roleCount} roles`, inline: true },
      { name: "Voice Activity", value: `${voiceUsers} users in VC`, inline: true },
      { name: "AI Activity", value: `${aiData.count} messages today`, inline: true },
      { name: "Most Active Channel", value: `#${mostActiveChannel}`, inline: true },
      { name: "Bot Uptime", value: uptimeStr, inline: true },
      { name: "Created", value: createdDate, inline: true }
    );

  if (guild.icon) embed.setThumbnail(guild.iconURL({ size: 512 }));

  // Cache the embed
  statsCache.set(guildId, { timestamp: Date.now(), data: embed });

  await interaction.reply({
    embeds: [embed],
    flags: 64,
  }).catch(() => {});
}

export function trackAiMessage(guildId) {
  const today = new Date().toDateString();
  const data = aiStats.get(guildId) || { date: today, count: 0 };

  // Reset if new day
  if (data.date !== today) {
    data.date = today;
    data.count = 0;
  }

  data.count++;
  aiStats.set(guildId, data);
}

export function getAiStats(guildId) {
  const today = new Date().toDateString();
  const data = aiStats.get(guildId) || { date: today, count: 0 };

  // Reset if new day
  if (data.date !== today) {
    data.date = today;
    data.count = 0;
  }

  return data;
}

export function initStatsData(loaded) {
  if (loaded && typeof loaded === "object") {
    for (const [guildId, data] of Object.entries(loaded)) {
      aiStats.set(guildId, data);
    }
  }
}

export function getStatsData() {
  const data = {};
  for (const [guildId, stats] of aiStats) {
    data[guildId] = stats;
  }
  return data;
}
