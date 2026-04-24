import { SlashCommandBuilder } from "discord.js";
import { musicEmbed, errorEmbed } from "../../utils/embeds.js";
import { getQueue, createQueue, connectToChannel, playSong, searchSong, searchPlaylist } from "../../music/player.js";

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play a song or playlist from YouTube or Spotify")
  .addStringOption((o) =>
    o.setName("query")
      .setDescription("Song name, YouTube URL/playlist, or Spotify track/playlist/album URL")
      .setRequired(true)
  );

export async function execute(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ embeds: [errorEmbed("Not in Voice", "Join a voice channel first!")], flags: 64 });
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions.has("Connect") || !permissions.has("Speak")) {
    return interaction.reply({
      embeds: [errorEmbed("No Permission", "I need permission to join and speak in that channel.")],
      flags: 64,
    });
  }

  // Defer immediately — Lavalink search can take a few seconds
  await interaction.deferReply();

  const query = interaction.options.getString("query");

  // ── Try playlist first ──────────────────────────────────────────────────────
  const playlist = await searchPlaylist(query);

  if (playlist) {
    if (!playlist.tracks.length) {
      return interaction.editReply({ embeds: [errorEmbed("Empty Playlist", "That playlist has no playable tracks.")] });
    }

    let queue = getQueue(interaction.guild.id);
    if (!queue) {
      queue = createQueue(interaction.guild.id, voiceChannel, interaction.channel);
      try {
        await connectToChannel(queue);
      } catch (error) {
        return interaction.editReply({ embeds: [errorEmbed("Connection Failed", error.message)] });
      }
    }

    const wasEmpty = queue.songs.length === 0;
    for (const track of playlist.tracks) {
      track.requestedBy = interaction.user.toString();
      queue.songs.push(track);
    }

    if (wasEmpty) await playSong(queue);

    return interaction.editReply({
      embeds: [
        musicEmbed(wasEmpty ? "Now Playing" : "Playlist Queued")
          .setDescription(`### ${playlist.name}`)
          .addFields(
            { name: "Tracks Added", value: `\`${playlist.tracks.length}\``, inline: true },
            { name: "First Track", value: playlist.tracks[0].title, inline: true },
            { name: "Requested by", value: interaction.user.toString(), inline: true },
          )
          .setThumbnail(playlist.tracks[0].thumbnail || null),
      ],
    });
  }

  // ── Single song ─────────────────────────────────────────────────────────────
  const song = await searchSong(query);
  if (!song) {
    return interaction.editReply({ embeds: [errorEmbed("Not Found", "Could not find a song matching that query.")] });
  }

  let queue = getQueue(interaction.guild.id);
  if (!queue) {
    queue = createQueue(interaction.guild.id, voiceChannel, interaction.channel);
    try {
      await connectToChannel(queue);
    } catch (error) {
      return interaction.editReply({ embeds: [errorEmbed("Connection Failed", error.message)] });
    }
  }

  song.requestedBy = interaction.user.toString();
  queue.songs.push(song);

  if (queue.songs.length === 1) {
    await playSong(queue);
    return interaction.editReply({
      embeds: [
        musicEmbed("Now Playing")
          .setDescription(`### [${song.title}](${song.url})`)
          .addFields(
            { name: "Duration", value: `\`${song.duration || "Unknown"}\``, inline: true },
            { name: "Requested by", value: song.requestedBy, inline: true },
            { name: "Position", value: "`#1 — Now Playing`", inline: true },
          )
          .setThumbnail(song.thumbnail || null),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      musicEmbed("Added to Queue")
        .setDescription(`### [${song.title}](${song.url})`)
        .addFields(
          { name: "Duration", value: `\`${song.duration || "Unknown"}\``, inline: true },
          { name: "Requested by", value: song.requestedBy, inline: true },
          { name: "Position in Queue", value: `\`#${queue.songs.length}\``, inline: true },
        )
        .setThumbnail(song.thumbnail || null),
    ],
  });
}
