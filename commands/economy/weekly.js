import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { claimWeekly } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("weekly")
  .setDescription("Claim your weekly coin reward (7-day cooldown)");

export async function execute(interaction) {
  const result = await claimWeekly(interaction.user.id);
  if (!result.success) {
    return interaction.reply({ content: `⏰ come back in **${result.hoursLeft}h**`, flags: MessageFlags.Ephemeral });
  }
  await interaction.reply(`✅ claimed **${result.coins}** weekly coins (streak: **${result.streak}** 🔥) — balance: **${result.newBalance?.toLocaleString()}**`);
}
