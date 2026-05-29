import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { tryDeductBalance, updateBalance, recordGameResult } from "../../database.js";
import { coinflipEmbed } from "../../ai/gameVisuals.js";
import { randomQuip } from "../../ai/gambling.js";
import { log } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("coinflip")
  .setDescription("Flip a coin — double or nothing")
  .addIntegerOption(opt => opt.setName("amount").setDescription("Coins to bet").setRequired(true).setMinValue(10))
  .addStringOption(opt => opt
    .setName("call")
    .setDescription("Heads or tails?")
    .setRequired(true)
    .addChoices({ name: "heads", value: "heads" }, { name: "tails", value: "tails" }));

export async function execute(interaction) {
  const amount = interaction.options.getInteger("amount");
  const choice = interaction.options.getString("call");
  const userId = interaction.user.id;

  // Atomic stake debit — read-check-deduct in one lock window so two parallel
  // /coinflip calls can't both pass a balance check before either debit lands.
  const debit = await tryDeductBalance(userId, amount, "gamble_coinflip_stake", `coinflip:${choice}`);
  if (!debit.ok) {
    if (debit.reason === "insufficient") {
      return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
  }

  const result = Math.random() < 0.5 ? "heads" : "tails";
  const won = result === choice;

  // Stake already deducted — credit 2× the stake on a win (refund + winnings).
  let newBalance = debit.newBalance;
  if (won) {
    try {
      newBalance = await updateBalance(userId, amount * 2, "gamble_coinflip_win", `coinflip:${choice}`);
    } catch (err) {
      log(`[Coinflip] win credit failed for ${userId} payout=${amount * 2}: ${err?.message || err}`);
    }
  }
  await recordGameResult(userId, "coinflip", won, amount, won ? amount * 2 : 0);

  const { embed, row } = coinflipEmbed(choice, result, won, amount, newBalance);
  await interaction.reply({ embeds: [embed], components: [row], content: randomQuip() });
}
