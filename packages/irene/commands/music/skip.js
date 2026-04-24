import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Skip the current song");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || !queue.playing) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "There's nothing to skip.")], ephemeral: true });
  }

  const { requireDj } = await import("./dj.js");
  if (!(await requireDj(interaction))) return;

  const botVc   = interaction.guild.members.cache.get(interaction.client.user.id)?.voice?.channel;
  const userVc  = interaction.member?.voice?.channel;
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator)
    || interaction.member?.id === interaction.guild.ownerId;

  if (!isAdmin && (!userVc || userVc.id !== botVc?.id)) {
    return interaction.reply({
      embeds: [errorEmbed("Not In Channel", "You need to be in the same voice channel as me to skip.")],
      ephemeral: true,
    });
  }

  const skipped = queue.songs[0];
  queue.player?.stopTrack();

  await interaction.reply({
    embeds: [
      successEmbed("Skipped", `Skipped **[${skipped.title}](${skipped.url})**`)
        .addFields({ name: "Up next", value: queue.songs[1] ? `[${queue.songs[1].title}](${queue.songs[1].url})` : "Nothing — queue is empty", inline: false }),
    ],
  });
}
