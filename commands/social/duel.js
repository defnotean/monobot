import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBalance, createDuel } from "../../database.js";
import { duelChallengeEmbed } from "../../ai/gameVisuals.js";

export const data = new SlashCommandBuilder()
  .setName("duel")
  .setDescription("Challenge someone to a coin duel")
  .addUserOption(opt => opt.setName("user").setDescription("Who to challenge").setRequired(true))
  .addIntegerOption(opt => opt.setName("amount").setDescription("Coins to wager").setRequired(true).setMinValue(10));

export async function execute(interaction) {
  const target = interaction.options.getUser("user");
  const amount = interaction.options.getInteger("amount");
  const userId = interaction.user.id;

  if (target.id === userId) return interaction.reply({ content: "you cant duel yourself", flags: MessageFlags.Ephemeral });
  if (target.bot) return interaction.reply({ content: "bots dont gamble... well, except me", flags: MessageFlags.Ephemeral });

  const wallet = await getBalance(userId);
  if (wallet.balance < amount) return interaction.reply({ content: `you only have ${wallet.balance} coins`, flags: MessageFlags.Ephemeral });

  const result = createDuel(userId, target.id, interaction.channelId, amount);
  if (!result.success) return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });

  const { embed, row } = duelChallengeEmbed(
    interaction.user.username,
    target.username,
    target.id,
    amount
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}
