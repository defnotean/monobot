import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue, deleteQueue } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop music and clear the queue");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "There's nothing to stop.")], ephemeral: true });
  }

  // ── Must be in the same VC as the bot, or an admin ────────────────────────
  const botVc   = interaction.guild.members.cache.get(interaction.client.user.id)?.voice?.channel;
  const userVc  = interaction.member?.voice?.channel;
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator)
    || interaction.member?.id === interaction.guild.ownerId;

  if (!isAdmin && (!userVc || userVc.id !== botVc?.id)) {
    return interaction.reply({
      embeds: [errorEmbed("Not In Channel", "You need to be in the same voice channel as me to stop the music.")],
      ephemeral: true,
    });
  }

  const songCount = queue.songs.length;
  deleteQueue(interaction.guild.id);

  await interaction.reply({
    embeds: [
      successEmbed("Stopped", `Music stopped and **${songCount}** song${songCount === 1 ? "" : "s"} cleared from the queue.`),
    ],
  });
}
