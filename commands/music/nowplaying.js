import { SlashCommandBuilder } from "discord.js";
import { musicEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("nowplaying")
  .setDescription("Show the currently playing song");

// ─── Safely parse "H:MM:SS" or "M:SS" into total seconds ─────────────────────
function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  const parts = str.trim().split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

export async function execute(interaction) {
  const queue = getQueue(interaction.guild.id);
  if (!queue || !queue.songs.length || !queue.playing) {
    return interaction.reply({ embeds: [errorEmbed("Nothing Playing", "No music is currently playing.")], ephemeral: true });
  }

  const song = queue.songs[0];
  const BAR_WIDTH = 25;

  let progressBar = "▰▱".repeat(Math.ceil(BAR_WIDTH / 2)).substring(0, BAR_WIDTH);
  let elapsed     = "0:00";
  let total       = song.duration || null;
  let remaining   = "?:??";
  let isLive      = false;

  const totalSec = parseDuration(song.duration);

  if (totalSec === null || totalSec === 0) {
    // Live stream or genuinely unknown duration
    isLive = true;
    total  = song.duration || "Unknown";
  } else if (queue.songStartedAt) {
    const fmt        = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const elapsedSec = Math.min(Math.floor((Date.now() - queue.songStartedAt) / 1000), totalSec);
    const remainingSec = totalSec - elapsedSec;
    const filled     = Math.round((elapsedSec / totalSec) * BAR_WIDTH);
    progressBar = "▰".repeat(filled) + "▱".repeat(BAR_WIDTH - filled);
    elapsed     = fmt(elapsedSec);
    remaining   = fmt(remainingSec);
    total       = song.duration;
  }

  const progressLine = isLive
    ? `🔴 **LIVE** — ${total}`
    : `${progressBar}\n\`${elapsed}\` ⏵ \`${remaining}\` / \`${total}\``;

  // Build loop status
  let loopStatus = "Off";
  if (queue.looping) loopStatus = "🔂 Track";
  else if (queue.loopingQueue) loopStatus = "🔁 Queue";

  await interaction.reply({
    embeds: [
      musicEmbed("Now Playing")
        .setDescription(`### [${song.title}](${song.url})\n\n${progressLine}`)
        .addFields(
          { name: "👤 Requested by", value: song.requestedBy || "Unknown", inline: true },
          { name: "🔊 Volume", value: `\`${queue.volume}%\``, inline: true },
          { name: "🔁 Loop", value: loopStatus, inline: true },
        )
        .setThumbnail(song.thumbnail || null),
    ],
  });
}
