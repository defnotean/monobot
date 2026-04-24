import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("loop")
  .setDescription("Toggle loop mode")
  .addStringOption((o) =>
    o.setName("mode")
      .setDescription("What to loop")
      .setRequired(true)
      .addChoices(
        { name: "Track — repeat current song", value: "track" },
        { name: "Queue — loop the entire queue", value: "queue" },
        { name: "Off — disable looping", value: "off" },
      )
  );

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || !queue.playing) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "Nothing is playing right now.")], ephemeral: true });
  }

  const mode = interaction.options.getString("mode");

  queue.looping = mode === "track";
  queue.loopingQueue = mode === "queue";

  const labels = {
    track: "🔂 Looping current track",
    queue: "🔁 Looping entire queue",
    off:   "Loop disabled",
  };

  await interaction.reply({
    embeds: [
      successEmbed("Loop Mode Updated", labels[mode])
        .addFields({ name: "Track", value: queue.songs[0]?.title || "Unknown", inline: false }),
    ],
  });
}
