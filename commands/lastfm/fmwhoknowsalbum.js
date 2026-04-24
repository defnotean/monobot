// /fmwhoknowsalbum — Who in this server has listened to an album?
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getAlbumInfo, getNowPlaying } from "../../lastfm/api.js";
import { getGuildWhoKnowsAlbum, getLinkedMembers, getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, albumUrl, getImage, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmwhoknowsalbum")
  .setDescription("Who in this server has listened to an album?")
  .addStringOption(opt =>
    opt.setName("album").setDescription("Album name (leave blank to use now playing)").setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("artist").setDescription("Artist name (required if providing album)").setRequired(false)
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  await interaction.deferReply();

  let albumInput  = interaction.options.getString("album");
  let artistInput = interaction.options.getString("artist");

  // Fall back to now playing if no album given
  if (!albumInput) {
    const linked = await getFmUser(interaction.user.id);
    if (!linked) {
      return interaction.editReply("provide an album name, or link your last.fm with `/fmset username` to use now playing");
    }
    try {
      const { track } = await getNowPlaying(linked.lastfm_username);
      if (!track) return interaction.editReply("nothing currently playing — provide an album name");
      albumInput  = track.album?.["#text"];
      artistInput = artistInput || track.artist?.["#text"] || track.artist?.name;
      if (!albumInput) return interaction.editReply("couldn't detect album from current track — provide it manually");
    } catch {
      return interaction.editReply("provide an album name, or link your last.fm with `/fmset username`");
    }
  }

  if (!artistInput) {
    return interaction.editReply("please provide an artist name along with the album");
  }

  // Resolve album name via Last.fm (autocorrects typos, gets canonical name)
  let resolvedArtist = artistInput;
  let resolvedAlbum  = albumInput;
  try {
    const info = await getAlbumInfo(artistInput, albumInput);
    resolvedArtist = info.artist;
    resolvedAlbum  = info.name;
  } catch {
    // Use raw input if lookup fails
  }

  // Fetch guild members
  let members;
  try {
    if (interaction.guild.members.cache.size < (interaction.guild.memberCount * 0.8)) {
      await interaction.guild.members.fetch();
    }
    members = interaction.guild.members.cache;
  } catch {
    members = interaction.guild.members.cache;
  }

  const memberIds = [...members.keys()].filter(id => !members.get(id)?.user?.bot);
  const linked    = await getLinkedMembers(memberIds);

  if (!linked.length) {
    return interaction.editReply("nobody in this server has linked their last.fm yet — use `/fmset username` to get started");
  }

  const linkedIds = linked.map(l => l.discord_id);
  const results   = await getGuildWhoKnowsAlbum(linkedIds, resolvedArtist, resolvedAlbum);

  if (!results.length) {
    return interaction.editReply(
      `nobody in this server has **${truncate(resolvedAlbum, 30)}** by **${truncate(resolvedArtist, 30)}** indexed\n` +
      `-# data populates when members use \`/fmset username\``
    );
  }

  const nameMap = Object.fromEntries(linked.map(l => [l.discord_id, l.lastfm_username]));

  const lines = await Promise.all(results.slice(0, 15).map(async (entry, i) => {
    const plays = fmtNum(entry.play_count);
    let displayName;
    try {
      const member = members.get(entry.discord_id);
      displayName = member?.displayName || nameMap[entry.discord_id] || entry.discord_id;
    } catch {
      displayName = nameMap[entry.discord_id] || entry.discord_id;
    }
    return `\`${String(i + 1).padStart(2)}\` **${truncate(displayName, 24)}** — ${plays} plays`;
  }));

  const totalListeners = results.length;
  const totalPlays     = results.reduce((s, r) => s + r.play_count, 0);

  // Get album art
  let albumArt = null;
  try {
    const info = await getAlbumInfo(resolvedArtist, resolvedAlbum);
    albumArt = getImage(info.image);
  } catch {}

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `Who knows ${resolvedAlbum} by ${resolvedArtist}`,
      url: albumUrl(resolvedArtist, resolvedAlbum),
    })
    .setDescription(lines.join("\n"))
    .setThumbnail(albumArt)
    .setFooter({
      text: `${totalListeners} listener${totalListeners === 1 ? "" : "s"} · ${fmtNum(totalPlays)} total plays`,
    });

  await interaction.editReply({ embeds: [embed] });
}
