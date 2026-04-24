import { SlashCommandBuilder } from "discord.js";
import { musicEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";
import { paginate, formatDuration } from "../../utils/pagination.js";

export const data = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("View the music queue");

// Helper to parse duration string to milliseconds
function parseDurationToMs(durationStr) {
  if (!durationStr || typeof durationStr !== "string") return 0;
  const parts = durationStr.trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return 0;
}

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || !queue.songs.length) {
    return interaction.reply({ embeds: [errorEmbed("Empty Queue", "The queue is empty.")], ephemeral: true });
  }

  const current = queue.songs[0];
  const upcoming = queue.songs.slice(1);

  // Calculate total duration
  let totalDurationMs = 0;
  for (const song of queue.songs) {
    totalDurationMs += parseDurationToMs(song.duration);
  }
  const totalDurationStr = formatDuration(totalDurationMs);

  // Status field value
  const statusParts = [];
  if (queue.looping)      statusParts.push("🔂 Track Loop");
  if (queue.loopingQueue) statusParts.push("🔁 Queue Loop");
  if (queue.shuffle)      statusParts.push("🔀 Shuffle");
  statusParts.push(`🔊 ${queue.volume}%`);
  const statusLine = statusParts.join("  ·  ");

  // Now playing line
  const nowPlayingValue = `[${current.title}](${current.url})\n\`${current.duration || "??"}\` — ${current.requestedBy || "Unknown"}`;

  if (upcoming.length === 0) {
    // Single song, no pagination needed
    const embed = musicEmbed(`Queue — 1 song`)
      .addFields(
        { name: "▶️ Now Playing", value: nowPlayingValue, inline: false },
        { name: "Status", value: statusLine, inline: false },
        { name: "⏱️ Total Duration", value: totalDurationStr, inline: true },
      );

    return interaction.reply({ embeds: [embed] });
  }

  // Multiple songs — use pagination for upcoming queue
  await paginate(interaction, {
    items: upcoming,
    itemsPerPage: 10,
    formatPage: (items, pageIndex, totalPages) => {
      const upNextLines = items.map((s, idx) => {
        const queuePos = pageIndex * 10 + idx + 2; // Position in queue (+2 because current is #1)
        const duration = s.duration || "??:??";
        return `\`${queuePos}.\` [${s.title}](${s.url})\n   \`${duration}\` — ${s.requestedBy || "Unknown"}`;
      });

      return musicEmbed(`Queue — ${queue.songs.length} songs`)
        .addFields(
          { name: "▶️ Now Playing", value: nowPlayingValue, inline: false },
          { name: "Status", value: statusLine, inline: false },
          { name: "📋 Up Next", value: upNextLines.join("\n") || "*(none)*", inline: false },
          { name: "⏱️ Total Duration", value: totalDurationStr, inline: true },
          { name: "Songs in Queue", value: `${queue.songs.length}`, inline: true },
        )
        .setFooter({ text: `Page ${pageIndex + 1} / ${totalPages}` });
    },
  });
}
