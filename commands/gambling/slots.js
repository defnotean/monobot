import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { getBalance, updateBalance, recordGameResult, getMood, getRelationship } from "../../database.js";
import { slotsEmbed, slotsAnimFrames, animateEmbed } from "../../ai/gameVisuals.js";
import { spinSlots, slotsPayout, randomQuip } from "../../ai/gambling.js";

export const data = new SlashCommandBuilder()
  .setName("slots")
  .setDescription("Spin the slot machine")
  .addIntegerOption(opt => opt.setName("amount").setDescription("Coins to bet").setRequired(true).setMinValue(10));

export async function execute(interaction) {
  const amount = interaction.options.getInteger("amount");
  const userId = interaction.user.id;
  const wallet = await getBalance(userId);

  if (wallet.balance < amount) return interaction.reply({ content: `you only have ${wallet.balance} coins`, flags: MessageFlags.Ephemeral });

  // Spin with mood/affinity rigging
  const mood = getMood();
  const rel = getRelationship(userId);
  const reels = spinSlots(mood.mood_score || 0, rel.affinity_score || 0);
  const { multiplier, label } = slotsPayout(reels);

  const payout = multiplier <= 0 ? -amount * Math.max(1, Math.abs(multiplier)) : Math.floor(amount * (multiplier - 1));
  const won = multiplier > 1;

  const newBalance = await updateBalance(userId, payout, won ? "gamble_slots_win" : "gamble_slots_loss", `slots:${label}`);
  await recordGameResult(userId, "slots", won, amount, won ? Math.floor(amount * multiplier) : 0);

  // Animated spin: defer, animate, then show result
  await interaction.deferReply();
  const animFrames = slotsAnimFrames(reels);
  const { embed, row } = slotsEmbed(reels, label, multiplier, amount, won, newBalance);
  animFrames.push({ embed, components: [row] });

  // Play animation via editing the deferred reply
  for (let i = 0; i < animFrames.length; i++) {
    const frame = animFrames[i];
    await interaction.editReply({ embeds: [frame.embed], components: frame.components || [], content: i === animFrames.length - 1 ? randomQuip() : "" });
    if (i < animFrames.length - 1) await new Promise(r => setTimeout(r, 700));
  }
}
