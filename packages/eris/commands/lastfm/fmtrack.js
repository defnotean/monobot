// /fmtrack — Show info about a track (defaults to now playing)
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTrackInfo, getNowPlaying } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, trackUrl, artistUrl, stripHtml, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmtrack")
  .setDescription("Get info about a track (defaults to your now playing)")
  .addStringOption(opt =>
    opt.setName("artist").setDescription("Artist name").setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("track").setDescription("Track name").setRequired(false)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Check another member's play count").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser("user") || interaction.user;
  const linked = await getFmUser(targetUser.id);
  const lfmUser = linked?.lastfm_username || null;

  let artistInput = interaction.options.getString("artist");
  let trackInput  = interaction.options.getString("track");

  // If no track provided, use currently playing
  if (!artistInput || !trackInput) {
    if (!lfmUser) {
      return interaction.editReply("provide an artist and track, or link your last.fm with `/fmset username`");
    }
    try {
      const { track } = await getNowPlaying(lfmUser);
      if (!track) return interaction.editReply("nothing currently playing — provide artist and track manually");
      artistInput = artistInput || track.artist?.["#text"] || track.artist?.name;
      trackInput  = trackInput  || track.name;
    } catch {
      return interaction.editReply("provide an artist and track, or link your last.fm with `/fmset username`");
    }
  }

  let info;
  try {
    info = await getTrackInfo(artistInput, trackInput, lfmUser);
  } catch (err) {
    return interaction.editReply(
      err.code === 6
        ? `couldn't find **${trackInput}** by **${artistInput}**`
        : `last.fm error: ${err.message}`
    );
  }

  const listeners = fmtNum(info.listeners);
  const scrobbles = fmtNum(info.playcount);
  const userPlays = info.userplaycount ? fmtNum(info.userplaycount) : null;
  const duration  = info.duration ? formatDuration(parseInt(info.duration)) : null;
  const tags      = (info.toptags?.tag || []).slice(0, 4).map(t => t.name).join(", ");
  const bio       = stripHtml(info.wiki?.summary || "").split("<a ")[0].trim();
  const albumName = info.album?.title;
  const albumArt  = info.album?.image?.find(i => i.size === "extralarge")?.["#text"] || null;

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${info.name} — ${info.artist?.name}`,
      url: trackUrl(info.artist?.name, info.name),
    })
    .setThumbnail(albumArt)
    .addFields(
      { name: "Listeners", value: listeners, inline: true },
      { name: "Scrobbles", value: scrobbles, inline: true },
    );

  if (userPlays && lfmUser) {
    embed.addFields({ name: `${lfmUser}'s plays`, value: userPlays, inline: true });
  }

  if (albumName) embed.addFields({ name: "Album", value: albumName, inline: true });
  if (duration)  embed.addFields({ name: "Duration", value: duration, inline: true });
  if (tags)      embed.addFields({ name: "Tags", value: tags, inline: true });
  if (bio)       embed.setDescription(truncate(bio, 350));

  await interaction.editReply({ embeds: [embed] });
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
