import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";
import { requireDjAndSameVc } from "../../utils/musicGuard.js";

export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Skip the current song");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || !queue.playing) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "There's nothing to skip.")], ephemeral: true });
  }

  // Same DJ + same-VC checks as before, factored into the shared guard.
  if (!(await requireDjAndSameVc(interaction))) return;

  const skipped = queue.songs[0];
  // Bypass single-track loop for this one stop — without this, stopTrack()
  // fires the "end" event and handleTrackEnd replays the same song under
  // `queue.looping`. Mirrors the working button path in interactionCreate.js.
  queue._skipOnce = true;
  queue.player?.stopTrack();

  await interaction.reply({
    embeds: [
      successEmbed("Skipped", `Skipped **[${skipped.title}](${skipped.url})**`)
        .addFields({ name: "Up next", value: queue.songs[1] ? `[${queue.songs[1].title}](${queue.songs[1].url})` : "Nothing — queue is empty", inline: false }),
    ],
  });
}
