import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBalance, updateBalance, getMarriage, createMarriage, hasItem } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("marry")
  .setDescription("Propose to someone (costs 500 coins + wedding ring)")
  .addUserOption(opt => opt.setName("user").setDescription("The one you love").setRequired(true));

export async function execute(interaction) {
  const target = interaction.options.getUser("user");
  const userId = interaction.user.id;

  if (target.id === userId) return interaction.reply({ content: "you cant marry yourself lol", flags: MessageFlags.Ephemeral });
  if (target.bot) return interaction.reply({ content: "bots have feelings too but not that kind", flags: MessageFlags.Ephemeral });

  const existing = await getMarriage(userId);
  if (existing) return interaction.reply({ content: "you're already married 💍", flags: MessageFlags.Ephemeral });
  const targetMarriage = await getMarriage(target.id);
  if (targetMarriage) return interaction.reply({ content: `${target.username} is already married`, flags: MessageFlags.Ephemeral });

  const wallet = await getBalance(userId);
  const hasRing = await hasItem(userId, "Wedding Ring");
  if (!hasRing) return interaction.reply({ content: "you need a **Wedding Ring** from the shop first 💍", flags: MessageFlags.Ephemeral });
  if (wallet.balance < 500) return interaction.reply({ content: "you need at least 500 coins to propose", flags: MessageFlags.Ephemeral });

  await updateBalance(userId, -500, "marriage", `married ${target.username}`);
  await createMarriage(userId, target.id);
  await interaction.reply(`💍 **${interaction.user.username}** and **${target.username}** are now married! +10% coin bonus for both`);
}
