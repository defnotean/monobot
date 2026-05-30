import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { getBalance, getMarriage, hasItem } from "../../database.js";

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

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`marry_accept_${userId}_${target.id}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`marry_decline_${userId}_${target.id}`).setLabel("Decline").setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: `💍 <@${target.id}>, **${interaction.user.username}** proposed. Accepting costs both users 500 coins and consumes the proposer's Wedding Ring.`,
    components: [row],
  });
}
