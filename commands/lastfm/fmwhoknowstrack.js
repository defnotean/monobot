// /fmwhoknowstrack — Who in this server has listened to a track?
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTrackInfo, getNowPlaying } from "../../lastfm/api.js";
import { getGuildWhoKnowsTrack, getLinkedMembers, getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, trackUrl, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmwhoknowstrack")
  .setDescription("Who in this server has listened to a track?")
  .addStringOption(opt =>
    opt.setName("track").setDescription("Track name (leave blank to use now playing)").setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("artist").setDescription("Artist name (required if providing track)").setRequired(false)
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  await interaction.deferReply();

  let trackInput  = interaction.options.getString("track");
  let artistInput = interaction.options.getString("artist");

  // Fall back to now playing if no track given
  if (!trackInput) {
    const linked = await getFmUser(interaction.user.id);
    if (!linked) {
      return interaction.editReply("provide a track name, or link your last.fm with `/fmset username` to use now playing");
    }
    try {
      const { track } = await getNowPlaying(linked.lastfm_username);
      if (!track) return interaction.editReply("nothing currently playing — provide a track name");
      trackInput  = track.name;
      artistInput = artistInput || track.artist?.["#text"] || track.artist?.name;
    } catch {
      return interaction.editReply("provide a track name, or link your last.fm with `/fmset username`");
    }
  }

  if (!artistInput) {
    return interaction.editReply("please provide an artist name along with the track");
  }

  // Resolve via Last.fm (autocorrect)
  let resolvedArtist = artistInput;
  let resolvedTrack  = trackInput;
  try {
    const info = await getTrackInfo(artistInput, trackInput);
    resolvedArtist = info.artist?.name || artistInput;
    resolvedTrack  = info.name || trackInput;
  } catch {}

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
  const results   = await getGuildWhoKnowsTrack(linkedIds, resolvedArtist, resolvedTrack);

  if (!results.length) {
    return interaction.editReply(
      `nobody in this server has **${truncate(resolvedTrack, 30)}** by **${truncate(resolvedArtist, 30)}** indexed\n` +
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

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `Who knows ${resolvedTrack} by ${resolvedArtist}`,
      url: trackUrl(resolvedArtist, resolvedTrack),
    })
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `${totalListeners} listener${totalListeners === 1 ? "" : "s"} · ${fmtNum(totalPlays)} total plays`,
    });

  await interaction.editReply({ embeds: [embed] });
}
