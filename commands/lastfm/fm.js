// /fm — Show now playing or last scrobbled track
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getNowPlaying, getAllTopArtists } from "../../lastfm/api.js";
import { getFmUser, indexUserArtists } from "../../lastfm/db.js";
import { FM_COLOR, getImage, userUrl, trackUrl, artistUrl, relativeTime, fmtPlays } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fm")
  .setDescription("Show your now playing or last scrobbled track")
  .addUserOption(opt =>
    opt.setName("user").setDescription("Another server member").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const target = interaction.options.getUser("user") || interaction.user;
  const linked = await getFmUser(target.id);

  if (!linked) {
    const self = target.id === interaction.user.id;
    return interaction.editReply(
      self
        ? "you haven't linked your last.fm yet — use `/fmset username <your username>`"
        : `${target.username} hasn't linked their last.fm`
    );
  }

  const lfmUser = linked.lastfm_username;

  let track, isNowPlaying;
  try {
    ({ track, isNowPlaying } = await getNowPlaying(lfmUser));
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  if (!track) {
    return interaction.editReply(`${lfmUser} hasn't scrobbled anything yet`);
  }

  const trackName   = track.name;
  const artistName  = track.artist?.["#text"] || track.artist?.name || "Unknown Artist";
  const albumName   = track.album?.["#text"] || null;
  const imageUrl    = getImage(track.image);
  const lfmUrl      = trackUrl(artistName, trackName);
  const timestamp   = track.date?.uts ? relativeTime(track.date.uts) : null;
  const userPlaycount = track.userplaycount ? fmtPlays(track.userplaycount) : null;

  const desc = [
    `by **[${artistName}](${artistUrl(artistName)})**`,
    albumName ? `on ${albumName}` : null,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${lfmUser} ${isNowPlaying ? "is listening to" : "last listened to"}`,
      url: userUrl(lfmUser),
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setTitle(trackName)
    .setURL(lfmUrl)
    .setDescription(desc)
    .setThumbnail(imageUrl);

  const footerParts = [];
  if (userPlaycount) footerParts.push(userPlaycount);
  if (!isNowPlaying && timestamp) footerParts.push(timestamp);
  if (footerParts.length) embed.setFooter({ text: footerParts.join(" · ") });

  await interaction.editReply({ embeds: [embed] });

  // Background-index top artists to keep WhoKnows data fresh (fire and forget)
  if (target.id === interaction.user.id) {
    getAllTopArtists(lfmUser, 200)
      .then(artists => indexUserArtists(target.id, artists))
      .catch(() => {});
  }
}
