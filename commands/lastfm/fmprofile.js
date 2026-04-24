// /fmprofile — Show a user's Last.fm profile stats including top genres
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getUserInfo, getTopArtists, getTopAlbums, getArtistInfo } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, userUrl, getImage, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmprofile")
  .setDescription("View a Last.fm profile overview")
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

  let userInfo, topArtists, topAlbums;
  try {
    [userInfo, topArtists, topAlbums] = await Promise.all([
      getUserInfo(lfmUser),
      getTopArtists(lfmUser, "overall", 5),
      getTopAlbums(lfmUser, "overall", 1),
    ]);
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  // Derive top genres by fetching tags from top 3 artists (best-effort, silent fail)
  let topGenres = [];
  try {
    const artistInfos = await Promise.allSettled(
      topArtists.slice(0, 3).map(a => getArtistInfo(a.name))
    );
    const tagWeights = new Map();
    for (const [i, result] of artistInfos.entries()) {
      if (result.status !== "fulfilled") continue;
      const plays = parseInt(topArtists[i]?.playcount || 1);
      const tags  = result.value?.tags?.tag || [];
      const list  = Array.isArray(tags) ? tags : [tags];
      for (const tag of list.slice(0, 4)) {
        const name = tag.name?.toLowerCase();
        if (!name || name.length < 2) continue;
        // Skip generic/useless tags
        if (["seen live", "favourite", "awesome", "good", "love", "loved", "cool", "music"].includes(name)) continue;
        tagWeights.set(name, (tagWeights.get(name) || 0) + plays);
      }
    }
    topGenres = [...tagWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);
  } catch { /* genre derivation is optional */ }

  const scrobbles = fmtNum(userInfo.playcount);
  const artists   = fmtNum(userInfo.artist_count);
  const albums    = fmtNum(userInfo.album_count);
  const tracks    = fmtNum(userInfo.track_count);
  const avatarUrl = userInfo.image?.find(i => i.size === "extralarge")?.["#text"] || null;
  const albumArt  = getImage(topAlbums[0]?.image);

  const registered = userInfo.registered?.unixtime
    ? new Date(parseInt(userInfo.registered.unixtime) * 1000).getFullYear()
    : null;

  const topArtistLines = topArtists.slice(0, 3)
    .map((a, i) => `${["🥇","🥈","🥉"][i]} **${truncate(a.name, 24)}** — ${fmtNum(a.playcount)} plays`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: lfmUser,
      url: userUrl(lfmUser),
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setThumbnail(avatarUrl || albumArt)
    .addFields(
      {
        name: "Scrobbles",
        value: [
          `**${scrobbles}** total`,
          `${artists} artists`,
          `${albums} albums`,
          `${tracks} tracks`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Top Artists (All Time)",
        value: topArtistLines || "no data",
        inline: true,
      }
    );

  if (topGenres.length) {
    embed.addFields({
      name: "Top Genres",
      value: topGenres.join(" · "),
      inline: false,
    });
  }

  if (registered) {
    embed.setFooter({ text: `Last.fm member since ${registered}` });
  }

  await interaction.editReply({ embeds: [embed] });
}
