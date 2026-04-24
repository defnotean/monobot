// /fmgenre — Browse top artists/albums for a Last.fm genre tag
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTagTopArtists, getTagTopAlbums, getTagInfo } from "../../lastfm/api.js";
import { FM_COLOR, stripHtml, truncate, fmtNum } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmgenre")
  .setDescription("Browse top artists or albums for a genre/tag")
  .addStringOption(opt =>
    opt.setName("genre").setDescription("Genre or tag (e.g. indie pop, jazz, metal)").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("type")
      .setDescription("What to show")
      .addChoices(
        { name: "Artists (default)", value: "artists" },
        { name: "Albums", value: "albums" },
      )
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const genre = interaction.options.getString("genre").trim();
  const type  = interaction.options.getString("type") || "artists";

  let items, tagInfo;
  try {
    [items, tagInfo] = await Promise.allSettled([
      type === "albums" ? getTagTopAlbums(genre, 10) : getTagTopArtists(genre, 10),
      getTagInfo(genre),
    ]).then(results => results.map(r => r.status === "fulfilled" ? r.value : null));
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  if (!items || !items.length) {
    return interaction.editReply(`couldn't find any ${type} for the tag **${genre}**`);
  }

  const tagName  = tagInfo?.name || genre;
  const tagTotal = tagInfo?.total ? `${parseInt(tagInfo.total).toLocaleString()} taggings` : null;
  const tagDesc  = tagInfo?.wiki?.summary ? truncate(stripHtml(tagInfo.wiki.summary).split("<a ")[0].trim(), 200) : null;

  let lines;
  if (type === "albums") {
    lines = items.map((a, i) =>
      `\`${String(i + 1).padStart(2)}\` **${truncate(a.name, 26)}** by ${truncate(a.artist?.name || "?", 22)}`
    );
  } else {
    lines = items.map((a, i) =>
      `\`${String(i + 1).padStart(2)}\` **${truncate(a.name, 36)}**`
    );
  }

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setTitle(`Top ${type} tagged "${tagName}"`)
    .setURL(`https://www.last.fm/tag/${encodeURIComponent(tagName)}`)
    .setDescription(lines.join("\n"));

  if (tagDesc) embed.addFields({ name: "About", value: tagDesc, inline: false });
  if (tagTotal) embed.setFooter({ text: tagTotal });

  await interaction.editReply({ embeds: [embed] });
}
