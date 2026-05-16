import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBankBalance, getBankCapacity, applyBankInterest, bankDeposit, bankWithdraw } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("bank")
  .setDescription("Manage your bank account")
  .addSubcommand(sub => sub.setName("info").setDescription("Check your bank balance"))
  .addSubcommand(sub => sub
    .setName("deposit")
    .setDescription("Deposit coins into your bank")
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount to deposit").setRequired(true).setMinValue(1)))
  .addSubcommand(sub => sub
    .setName("withdraw")
    .setDescription("Withdraw coins from your bank")
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount to withdraw").setRequired(true).setMinValue(1)));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === "info") {
    const bank = await getBankBalance(userId);
    const cap = await getBankCapacity(userId);
    const interest = await applyBankInterest(userId);
    let msg = `🏦 **Bank:** ${bank.balance?.toLocaleString()}/${cap?.toLocaleString()} coins`;
    if (interest > 0) msg += `\n📈 earned **${interest}** interest!`;
    return interaction.reply(msg);
  }

  const amount = interaction.options.getInteger("amount");

  if (sub === "deposit") {
    const result = await bankDeposit(userId, amount);
    if (!result.ok) {
      if (result.reason === "insufficient_wallet") {
        return interaction.reply({ content: `you only have ${result.balance} coins`, flags: MessageFlags.Ephemeral });
      }
      if (result.reason === "bank_full") {
        return interaction.reply({ content: `bank capacity is ${result.capacity} — you can deposit ${result.maxDeposit} more`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `deposit failed: ${result.reason}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply(`✅ deposited **${amount.toLocaleString()}** coins`);
  }

  if (sub === "withdraw") {
    const result = await bankWithdraw(userId, amount);
    if (!result.ok) {
      if (result.reason === "insufficient_bank") {
        return interaction.reply({ content: `you only have ${result.balance} in the bank`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `withdraw failed: ${result.reason}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply(`✅ withdrew **${amount.toLocaleString()}** coins`);
  }
}
