import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("resume")
  .setDescription("Resume the paused song");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "Nothing to resume.")], ephemeral: true });
  }

  if (!queue.playing && !queue.songs.length) {
    return interaction.reply({ content: "nothing to resume — queue is empty", flags: 64 });
  }

  if (!queue.player?.paused) {
    return interaction.reply({ embeds: [errorEmbed("Not Paused", "Music isn't paused right now.")], ephemeral: true });
  }

  queue.player?.setPaused(false);
  await interaction.reply({
    embeds: [successEmbed("Resumed", `Resumed **${queue.songs[0]?.title || "current track"}**`)],
  });
}
