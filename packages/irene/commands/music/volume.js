import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";
import { requireDjAndSameVc } from "../../utils/musicGuard.js";

export const data = new SlashCommandBuilder()
  .setName("volume")
  .setDescription("Set the music volume")
  .addIntegerOption((o) =>
    o.setName("level").setDescription("Volume level (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)
  );

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "No music is playing.")], ephemeral: true });
  }

  if (!(await requireDjAndSameVc(interaction))) return;

  const level = interaction.options.getInteger("level");
  queue.volume = level;

  // Update Lavalink player volume
  if (queue.player) {
    queue.player.setGlobalVolume(level);
  }

  const bar = "█".repeat(Math.round(level / 10)) + "░".repeat(10 - Math.round(level / 10));

  await interaction.reply({
    embeds: [
      successEmbed("Volume Updated", `${bar} \`${level}%\``)
        .addFields({ name: "Track", value: queue.songs[0]?.title || "Unknown", inline: false }),
    ],
  });
}
