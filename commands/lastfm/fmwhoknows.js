// /fmwhoknows — Who in this server listens to an artist?
// Uses an indexed play-count cache (fm_user_artists) populated when members
// run /fm or /fmset. Results improve over time as more people use the bot.
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getArtistInfo } from "../../lastfm/api.js";
import { getGuildWhoKnows, getLinkedMembers, getCrown, updateCrown } from "../../lastfm/db.js";
import { FM_COLOR, artistUrl, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmwhoknows")
  .setDescription("Who in this server listens to an artist?")
  .addStringOption(opt =>
    opt.setName("artist").setDescription("Artist name").setRequired(true)
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  await interaction.deferReply();

  const artistInput = interaction.options.getString("artist");

  // Resolve artist name via Last.fm (autocorrects typos)
  let resolvedArtist = artistInput;
  try {
    const info = await getArtistInfo(artistInput);
    resolvedArtist = info.name;
  } catch {
    // Use the raw input if API fails
  }

  // Fetch guild members (uses cache if already loaded, falls back to fetch)
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

  // Get linked accounts for this guild
  const linked = await getLinkedMembers(memberIds);
  if (!linked.length) {
    return interaction.editReply("nobody in this server has linked their last.fm yet — use `/fmset username` to get started");
  }

  // Query indexed artist data
  const linkedIds = linked.map(l => l.discord_id);
  const results   = await getGuildWhoKnows(linkedIds, resolvedArtist);

  if (!results.length) {
    return interaction.editReply(
      `nobody in this server has **${truncate(resolvedArtist, 40)}** indexed yet\n` +
      `-# data builds up as members use \`/fm\` and \`/fmset\``
    );
  }

  // Build username map
  const nameMap = Object.fromEntries(linked.map(l => [l.discord_id, l.lastfm_username]));

  // Update crown for #1 holder
  const topEntry = results[0];
  const { changed, previousHolder } = await updateCrown(
    interaction.guild.id,
    resolvedArtist,
    topEntry.discord_id,
    topEntry.play_count
  );

  const crown = await getCrown(interaction.guild.id, resolvedArtist);

  // Build display lines
  const lines = await Promise.all(results.slice(0, 15).map(async (entry, i) => {
    const hasCrown = crown?.discord_id === entry.discord_id;
    const crownIcon = hasCrown ? "👑 " : "";
    const plays = fmtNum(entry.play_count);

    let displayName;
    try {
      const member = members.get(entry.discord_id);
      displayName = member?.displayName || nameMap[entry.discord_id] || entry.discord_id;
    } catch {
      displayName = nameMap[entry.discord_id] || entry.discord_id;
    }

    return `\`${String(i + 1).padStart(2)}\` ${crownIcon}**${truncate(displayName, 24)}** — ${plays} plays`;
  }));

  const totalListeners = results.length;
  const totalPlays = results.reduce((sum, r) => sum + r.play_count, 0);

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({ name: `Who knows ${resolvedArtist}`, url: artistUrl(resolvedArtist) })
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `${totalListeners} listener${totalListeners === 1 ? "" : "s"} · ${fmtNum(totalPlays)} total plays`,
    });

  if (changed && previousHolder && previousHolder !== topEntry.discord_id) {
    const prevMember = members.get(previousHolder);
    const prevName = prevMember?.displayName || previousHolder;
    embed.addFields({
      name: "👑 crown stolen",
      value: `${truncate(displayNameFor(members, topEntry.discord_id, nameMap), 24)} took the crown from ${truncate(prevName, 24)}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

function displayNameFor(members, id, nameMap) {
  try {
    return members.get(id)?.displayName || nameMap[id] || id;
  } catch {
    return nameMap[id] || id;
  }
}
