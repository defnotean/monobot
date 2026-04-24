import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("pause")
  .setDescription("Pause the current song");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || !queue.playing) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "Nothing to pause.")], ephemeral: true });
  }

  if (queue.player?.paused) {
    return interaction.reply({ embeds: [errorEmbed("Already Paused", "Music is already paused. Use `/resume` to continue.")], ephemeral: true });
  }

  queue.player?.setPaused(true);
  await interaction.reply({
    embeds: [
      successEmbed("Paused", `**${queue.songs[0]?.title || "Current track"}** has been paused.`)
        .addFields({ name: "Resume", value: "Use `/resume` to continue playback.", inline: false }),
    ],
  });
}
