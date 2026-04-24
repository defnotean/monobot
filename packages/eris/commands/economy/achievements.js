import { SlashCommandBuilder } from "discord.js";
import { getUnlockedAchievements } from "../../database.js";
import { ACHIEVEMENTS } from "../../ai/economy.js";
import { achievementsEmbed } from "../../ai/gameVisuals.js";

export const data = new SlashCommandBuilder()
  .setName("achievements")
  .setDescription("View your unlocked achievements");

export async function execute(interaction) {
  const userId = interaction.user.id;
  const unlocked = await getUnlockedAchievements(userId);
  const unlockedKeys = new Set((unlocked || []).map(a => a.achievement_key));
  const embed = achievementsEmbed(ACHIEVEMENTS, unlockedKeys, interaction.user.displayName);
  await interaction.reply({ embeds: [embed] });
}
