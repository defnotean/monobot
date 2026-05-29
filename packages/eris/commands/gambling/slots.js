import { SlashCommandBuilder , MessageFlags } from "discord.js";
import { tryDeductBalance, updateBalance, recordGameResult, getMood, getRelationship } from "../../database.js";
import { slotsEmbed, slotsAnimFrames, animateEmbed } from "../../ai/gameVisuals.js";
import { spinSlots, slotsPayout, randomQuip } from "../../ai/gambling.js";
import { log } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("slots")
  .setDescription("Spin the slot machine")
  .addIntegerOption(opt => opt.setName("amount").setDescription("Coins to bet").setRequired(true).setMinValue(10));

export async function execute(interaction) {
  const amount = interaction.options.getInteger("amount");
  const userId = interaction.user.id;

  // Atomic stake debit — closes the check-then-update race on parallel /slots.
  const debit = await tryDeductBalance(userId, amount, "gamble_slots_stake", "slots:spin");
  if (!debit.ok) {
    if (debit.reason === "insufficient") {
      return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
  }

  // Spin with mood/affinity rigging
  const mood = getMood();
  const rel = getRelationship(userId);
  const reels = spinSlots(mood.mood_score || 0, rel.affinity_score || 0);
  const { multiplier, label } = slotsPayout(reels);

  // Stake is already debited. Compute the credit relative to that debit so the
  // net change matches the original `multiplier`-based payout semantics:
  //   multiplier=-2 (double-skull) → additional -amount (total -2× stake)
  //   multiplier=0  (single skull / no match) → 0 (stake lost, no further change)
  //   multiplier=1  (push) → +amount (refund stake)
  //   multiplier>1  (win) → +Math.floor(amount * multiplier) (refund + winnings)
  const credit = multiplier === -2
    ? -amount
    : multiplier <= 0
      ? 0
      : Math.floor(amount * multiplier);
  const won = multiplier > 1;

  let newBalance = debit.newBalance;
  if (credit !== 0) {
    try {
      newBalance = await updateBalance(userId, credit, won ? "gamble_slots_win" : "gamble_slots_loss", `slots:${label}`);
    } catch (err) {
      log(`[Slots] credit failed for ${userId} credit=${credit}: ${err?.message || err}`);
    }
  }
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
