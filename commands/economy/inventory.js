import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getInventory } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("inventory")
  .setDescription("Check your inventory")
  .addUserOption(opt => opt.setName("user").setDescription("User to check").setRequired(false));

export async function execute(interaction) {
  const target = interaction.options.getUser("user") || interaction.user;
  const items = await getInventory(target.id);
  if (!items.length) return interaction.reply(`${target.id === interaction.user.id ? "you have" : `${target.username} has`} nothing — time to shop 🛒`);

  const grouped = {};
  for (const item of items) {
    grouped[item.item_name] = (grouped[item.item_name] || 0) + 1;
  }
  const lines = Object.entries(grouped).map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`);

  const embed = new EmbedBuilder()
    .setTitle(`🎒 ${target.username}'s Inventory`)
    .setDescription(lines.join("\n"))
    .setColor(0x9333EA);

  await interaction.reply({ embeds: [embed] });
}
