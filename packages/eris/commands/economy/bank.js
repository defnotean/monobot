import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBankBalance, updateBankBalance, getBankCapacity, getBalance, updateBalance, applyBankInterest } from "../../database.js";

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
    const wallet = await getBalance(userId);
    if (wallet.balance < amount) return interaction.reply({ content: `you only have ${wallet.balance} coins`, flags: MessageFlags.Ephemeral });
    const cap = await getBankCapacity(userId);
    const bank = await getBankBalance(userId);
    if (bank.balance + amount > cap) return interaction.reply({ content: `bank capacity is ${cap} — you can deposit ${cap - bank.balance} more`, flags: MessageFlags.Ephemeral });
    await updateBalance(userId, -amount, "bank_deposit");
    await updateBankBalance(userId, amount);
    return interaction.reply(`✅ deposited **${amount.toLocaleString()}** coins`);
  }

  if (sub === "withdraw") {
    const bank = await getBankBalance(userId);
    if (bank.balance < amount) return interaction.reply({ content: `you only have ${bank.balance} in the bank`, flags: MessageFlags.Ephemeral });
    await updateBankBalance(userId, -amount);
    await updateBalance(userId, amount, "bank_withdraw");
    return interaction.reply(`✅ withdrew **${amount.toLocaleString()}** coins`);
  }
}
