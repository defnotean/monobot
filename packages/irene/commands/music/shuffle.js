import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";
import { requireDjAndSameVc } from "../../utils/musicGuard.js";

export const data = new SlashCommandBuilder()
  .setName("shuffle")
  .setDescription("Shuffle the upcoming queue or toggle auto-shuffle");

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || queue.songs.length < 2) {
    return interaction.reply({ embeds: [errorEmbed("Nothing to Shuffle", "Need at least 2 songs in the queue.")], ephemeral: true });
  }

  if (!(await requireDjAndSameVc(interaction))) return;

  // One-time shuffle: randomise all songs after the currently playing one
  const current = queue.songs[0];
  const rest = queue.songs.slice(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  queue.songs = [current, ...rest];

  // Toggle auto-shuffle on for future auto-advances
  queue.shuffle = !queue.shuffle;

  await interaction.reply({
    embeds: [
      successEmbed("Queue Shuffled", `Reshuffled **${rest.length}** upcoming track${rest.length === 1 ? "" : "s"}.`)
        .addFields(
          { name: "Auto-Shuffle", value: queue.shuffle ? "🔀 On" : "Off", inline: true },
          { name: "Up Next", value: rest[0]?.title || "Empty", inline: true },
        ),
    ],
  });
}
