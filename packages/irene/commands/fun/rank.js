import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";
import { getXpData, getLeaderboard, xpNeededForLevel } from "../../utils/leveling.js";

export const data = new SlashCommandBuilder()
  .setName("rank")
  .setDescription("Check your or someone else's XP rank")
  .addUserOption((o) => o.setName("user").setDescription("User to check (default: you)"));

export async function execute(interaction) {
  const user = interaction.options.getUser("user") || interaction.user;

  const xpData = getXpData(interaction.guildId, user.id);
  const { xp, level, totalXp } = xpData;

  // Get user's rank
  const leaderboard = getLeaderboard(interaction.guildId, 100);
  const rank = leaderboard.findIndex((u) => u.userId === user.id) + 1 || "Unranked";

  // XP for next level
  const xpNeeded = xpNeededForLevel(level + 1);

  // Build progress bar (20 chars wide)
  const barWidth = 20;
  const filled = Math.floor((xp / xpNeeded) * barWidth);
  const empty = barWidth - filled;
  const progressBar = "▰".repeat(filled) + "▱".repeat(empty);

  // Build embed with fields
  const embed = primaryEmbed(`${user.username}'s Rank`, null);
  embed.setThumbnail(user.displayAvatarURL());

  if (xp === 0 && level === 0) {
    embed.setDescription("no XP yet — start chatting!");
  } else {
    embed.addFields(
      { name: "Level", value: level.toString(), inline: true },
      { name: "Rank", value: rank !== "Unranked" ? `#${rank}` : "Unranked", inline: true },
      { name: "Current XP", value: `${xp}/${xpNeeded}`, inline: true },
      { name: "Total XP", value: totalXp.toString(), inline: true },
      { name: "XP for Next Level", value: `${xpNeeded - xp} remaining`, inline: true },
      { name: "Progress", value: `\`${progressBar}\` ${Math.floor((xp / xpNeeded) * 100)}%`, inline: false }
    );
  }

  await interaction.reply({ embeds: [embed] });
}
