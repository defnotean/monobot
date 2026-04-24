import { SlashCommandBuilder } from "discord.js";
import { getBalance } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Check your coin balance")
  .addUserOption(opt => opt.setName("user").setDescription("User to check").setRequired(false));

export async function execute(interaction) {
  const target = interaction.options.getUser("user") || interaction.user;
  const econ = await getBalance(target.id);
  const bal = econ.balance?.toLocaleString() || "100";
  await interaction.reply(`💰 **${target.username}** has **${bal}** coins`);
}
