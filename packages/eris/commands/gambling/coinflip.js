import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBalance, updateBalance, recordGameResult } from "../../database.js";
import { coinflipEmbed } from "../../ai/gameVisuals.js";
import { randomQuip } from "../../ai/gambling.js";

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
  const wallet = await getBalance(userId);

  if (wallet.balance < amount) return interaction.reply({ content: `you only have ${wallet.balance} coins`, flags: MessageFlags.Ephemeral });

  const result = Math.random() < 0.5 ? "heads" : "tails";
  const won = result === choice;

  const newBalance = await updateBalance(userId, won ? amount : -amount, won ? "gamble_coinflip_win" : "gamble_coinflip_loss", `coinflip:${choice}`);
  await recordGameResult(userId, "coinflip", won, amount, won ? amount * 2 : 0);

  const { embed, row } = coinflipEmbed(choice, result, won, amount, newBalance);
  await interaction.reply({ embeds: [embed], components: [row], content: randomQuip() });
}
