import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { tryDeductBalance, updateBalance, recordGameResult } from "../../database.js";
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

  // Atomic stake debit — closes the check-then-update race on parallel /dice.
  const debit = await tryDeductBalance(userId, amount, "gamble_dice_stake", `dice:${guess}`);
  if (!debit.ok) {
    if (debit.reason === "insufficient") {
      return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
  }

  const roll = Math.floor(Math.random() * 6) + 1;
  const won = roll === guess;

  // Stake already deducted. On win, credit 5× the stake (refund + 4× winnings)
  // to preserve the original net payout (amount * 4).
  let newBalance = debit.newBalance;
  if (won) {
    try {
      newBalance = await updateBalance(userId, amount * 5, "gamble_dice_win", `dice:${guess}`);
    } catch (err) {
      console.error(`[Dice] win credit failed for ${userId} payout=${amount * 5}:`, err);
    }
  }
  await recordGameResult(userId, "dice", won, amount, won ? amount * 5 : 0);

  const resultEmbed = diceEmbed(guess, roll, won, amount, newBalance);
  const { row } = diceButtonsEmbed(amount);
  await interaction.reply({ embeds: [resultEmbed], components: [row], content: randomQuip() });
}
