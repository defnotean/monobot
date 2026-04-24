import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBalance, updateBalance, recordGameResult } from "../../database.js";
import { diceEmbed, diceButtonsEmbed } from "../../ai/gameVisuals.js";
import { randomQuip } from "../../ai/gambling.js";

export const data = new SlashCommandBuilder()
  .setName("dice")
  .setDescription("Roll a die — guess the number for big wins")
  .addIntegerOption(opt => opt.setName("amount").setDescription("Coins to bet").setRequired(true).setMinValue(10))
  .addIntegerOption(opt => opt.setName("guess").setDescription("Your guess (1-6)").setRequired(true).setMinValue(1).setMaxValue(6));

export async function execute(interaction) {
  const amount = interaction.options.getInteger("amount");
  const guess = interaction.options.getInteger("guess");
  const userId = interaction.user.id;
  const wallet = await getBalance(userId);

  if (wallet.balance < amount) return interaction.reply({ content: `you only have ${wallet.balance} coins`, flags: MessageFlags.Ephemeral });

  const roll = Math.floor(Math.random() * 6) + 1;
  const won = roll === guess;
  const payout = won ? amount * 4 : -amount;

  const newBalance = await updateBalance(userId, payout, won ? "gamble_dice_win" : "gamble_dice_loss", `dice:${guess}`);
  await recordGameResult(userId, "dice", won, amount, won ? amount * 5 : 0);

  const resultEmbed = diceEmbed(guess, roll, won, amount, newBalance);
  const { row } = diceButtonsEmbed(amount);
  await interaction.reply({ embeds: [resultEmbed], components: [row], content: randomQuip() });
}
