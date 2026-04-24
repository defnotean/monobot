import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import config from "../../config.js";
import * as db from "../../database.js";
import { MOOD_MAX_ODDS_SHIFT } from "../../ai/gambling.js";

export const data = new SlashCommandBuilder()
  .setName("mood")
  .setDescription("See Eris's current mood and how it's affecting gambling odds");

function moodLabel(score) {
  if (score >= 60) return "on top of the world";
  if (score >= 30) return "genuinely happy";
  if (score >= 10) return "pretty good";
  if (score >= -10) return "neutral";
  if (score >= -30) return "a bit off";
  if (score >= -60) return "in a bad mood";
  return "miserable";
}

export async function execute(interaction) {
  const mood = db.getMood();
  const rel = db.getRelationship(interaction.user.id);

  const score = Math.max(-100, Math.min(100, Number(mood.mood_score) || 0));
  const energy = Math.max(0, Math.min(100, Number(mood.energy) || 50));
  const affinity = Math.max(-100, Math.min(100, Number(rel.affinity_score) || 0));

  // Match gambling.js: moodInfluence = (score / 100) * MOOD_MAX_ODDS_SHIFT
  const pctShift = ((score / 100) * MOOD_MAX_ODDS_SHIFT) * 100;
  const favor = pctShift > 0.1 ? "in your favor" : pctShift < -0.1 ? "against you" : "basically neutral";

  const affinityNote =
    affinity > 30 ? "she likes you — slot rigs may favor you when she's also happy"
    : affinity < -10 ? "she's not a fan — slot rigs may nudge against you when she's salty"
    : "you're on neutral ground with her";

  const embed = new EmbedBuilder()
    .setColor(config.colors.primary)
    .setTitle("Eris's mood")
    .setDescription(`right now she's **${moodLabel(score)}** — score **${score}**, energy **${energy}**.`)
    .addFields(
      {
        name: "Gambling odds modifier",
        value: `coinflip/RNG probabilities shift by **${pctShift >= 0 ? "+" : ""}${pctShift.toFixed(2)}%** (${favor}). Hard cap is ±${(MOOD_MAX_ODDS_SHIFT * 100).toFixed(0)}%.`,
      },
      {
        name: "Slots",
        value: "10% of spins are mood-influenced. The worst-case negative nudge forces a no-match — she won't double-loss you for being in a bad mood.",
      },
      {
        name: "How she feels about you",
        value: affinityNote + ` (affinity **${affinity}**, ${rel.interactions_count || 0} interactions).`,
      },
    )
    .setFooter({ text: "transparency on. no more hidden house edge." });

  await interaction.reply({ embeds: [embed] });
}
