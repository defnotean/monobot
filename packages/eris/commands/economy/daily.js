import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { claimDaily } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("daily")
  .setDescription("Claim your daily coin reward");

export async function execute(interaction) {
  const result = await claimDaily(interaction.user.id);
  if (!result.success) {
    if (result.error === "claim_failed") {
      return interaction.reply({ content: "⚠️ something went wrong saving your claim — try again in a moment.", flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: `⏰ come back in **${result.hoursLeft}h**`, flags: MessageFlags.Ephemeral });
  }
  await interaction.reply(`✅ claimed **${result.coins}** coins (streak: **${result.streak}** 🔥) — balance: **${result.newBalance?.toLocaleString()}**`);
}
