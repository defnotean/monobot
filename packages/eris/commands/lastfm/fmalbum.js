// /fmalbum — Show info about an album
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getAlbumInfo, getNowPlaying } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, albumUrl, getImage, stripHtml, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmalbum")
  .setDescription("Get info about an album (defaults to your currently playing)")
  .addStringOption(opt =>
    opt.setName("artist").setDescription("Artist name").setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("album").setDescription("Album name").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const linked = await getFmUser(interaction.user.id);
  const lfmUser = linked?.lastfm_username || null;

  let artistInput = interaction.options.getString("artist");
  let albumInput  = interaction.options.getString("album");

  // If no input, use currently playing
  if (!artistInput || !albumInput) {
    if (!lfmUser) {
      return interaction.editReply("provide an artist and album, or link your last.fm with `/fmset username`");
    }
    try {
      const { track } = await getNowPlaying(lfmUser);
      if (!track) return interaction.editReply("nothing currently playing — provide artist and album manually");
      artistInput = artistInput || track.artist?.["#text"] || track.artist?.name;
      albumInput  = albumInput  || track.album?.["#text"];
      if (!albumInput) return interaction.editReply("couldn't detect album from current track — provide it manually");
    } catch {
      return interaction.editReply("provide an artist and album, or link your last.fm with `/fmset username`");
    }
  }

  let info;
  try {
    info = await getAlbumInfo(artistInput, albumInput, lfmUser);
  } catch (err) {
    return interaction.editReply(
      err.code === 6
        ? `couldn't find **${albumInput}** by **${artistInput}**`
        : `last.fm error: ${err.message}`
    );
  }

  const imageUrl   = getImage(info.image);
  const listeners  = fmtNum(info.listeners);
  const scrobbles  = fmtNum(info.playcount);
  const userPlays  = info.userplaycount ? fmtNum(info.userplaycount) : null;
  const tracks     = (info.tracks?.track || []);
  const trackCount = Array.isArray(tracks) ? tracks.length : (tracks ? 1 : 0);
  const tags       = (info.tags?.tag || []).slice(0, 4).map(t => t.name).join(", ");
  const bio        = stripHtml(info.wiki?.summary || "").split("<a ")[0].trim();

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({ name: `${info.name} — ${info.artist}`, url: albumUrl(info.artist, info.name) })
    .setThumbnail(imageUrl)
    .addFields(
      { name: "Listeners", value: listeners, inline: true },
      { name: "Scrobbles", value: scrobbles, inline: true },
    );

  if (userPlays && lfmUser) {
    embed.addFields({ name: `${lfmUser}'s plays`, value: userPlays, inline: true });
  }

  if (trackCount) embed.addFields({ name: "Tracks", value: String(trackCount), inline: true });
  if (tags)       embed.addFields({ name: "Tags", value: tags, inline: true });

  if (bio) embed.setDescription(truncate(bio, 350));

  await interaction.editReply({ embeds: [embed] });
}
