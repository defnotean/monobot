// /fmartist — Show info about an artist (bio, stats, user plays)
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getArtistInfo, getArtistTopAlbums } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, artistUrl, stripHtml, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmartist")
  .setDescription("Get info about an artist")
  .addStringOption(opt =>
    opt.setName("artist").setDescription("Artist name").setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const artistInput = interaction.options.getString("artist");
  const linked = await getFmUser(interaction.user.id);
  const lfmUser = linked?.lastfm_username || null;

  let info, topAlbums;
  try {
    [info, topAlbums] = await Promise.all([
      getArtistInfo(artistInput, lfmUser),
      getArtistTopAlbums(artistInput, 3),
    ]);
  } catch (err) {
    return interaction.editReply(
      err.code === 6
        ? `couldn't find an artist named **${artistInput}**`
        : `last.fm error: ${err.message}`
    );
  }

  const bio = stripHtml(info.bio?.summary || "").split("<a ")[0].trim();
  const listeners = fmtNum(info.stats?.listeners);
  const scrobbles = fmtNum(info.stats?.playcount);
  const userPlays  = info.stats?.userplaycount ? fmtNum(info.stats.userplaycount) : null;
  const tags = (info.tags?.tag || []).slice(0, 4).map(t => t.name).join(", ");

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({ name: info.name, url: artistUrl(info.name) })
    .addFields(
      { name: "Listeners", value: listeners, inline: true },
      { name: "Scrobbles", value: scrobbles, inline: true },
    );

  if (userPlays && lfmUser) {
    embed.addFields({ name: `${lfmUser}'s plays`, value: userPlays, inline: true });
  }

  if (tags) {
    embed.addFields({ name: "Tags", value: tags, inline: false });
  }

  if (topAlbums.length) {
    const albumList = topAlbums.map((a, i) => `${i + 1}. ${a.name}`).join("\n");
    embed.addFields({ name: "Top Albums", value: albumList, inline: false });
  }

  if (bio) {
    embed.setDescription(truncate(bio, 400));
  }

  await interaction.editReply({ embeds: [embed] });
}
