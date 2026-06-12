import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue, deleteQueue } from "../../music/player.js";
import { requireDjAndSameVc } from "../../utils/musicGuard.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop music and clear the queue");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "There's nothing to stop.")], ephemeral: true });
  }

  // ── DJ + same-VC — /stop is documented as DJ-protected (see /dj) ──────────
  if (!(await requireDjAndSameVc(interaction))) return;

  const songCount = queue.songs.length;
  deleteQueue(interaction.guild.id);

  await interaction.reply({
    embeds: [
      successEmbed("Stopped", `Music stopped and **${songCount}** song${songCount === 1 ? "" : "s"} cleared from the queue.`),
    ],
  });
}
