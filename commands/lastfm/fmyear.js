// /fmyear — Year in review: top artists/albums/tracks + monthly scrobble breakdown
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTopArtists, getTopAlbums, getTopTracks, getUserInfo, getMonthlyScrobbleCounts } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, userUrl, getImage, fmtNum, truncate } from "../../lastfm/helpers.js";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const BAR_CHARS   = "▁▂▃▄▅▆▇█";

function sparkline(counts) {
  const max = Math.max(...counts, 1);
  return counts.map(n => {
    const idx = Math.floor((n / max) * (BAR_CHARS.length - 1));
    return BAR_CHARS[idx];
  }).join("");
}

export const data = new SlashCommandBuilder()
  .setName("fmyear")
  .setDescription("Year in review — top artists, albums, tracks, and monthly breakdown")
  .addIntegerOption(opt =>
    opt.setName("year")
      .setDescription("Year to review (defaults to current year)")
      .setMinValue(2002)
      .setMaxValue(new Date().getFullYear())
      .setRequired(false)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Another server member").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const target = interaction.options.getUser("user") || interaction.user;
  const year   = interaction.options.getInteger("year") || new Date().getFullYear();
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

  // Fetch all data in parallel: top artists/albums/tracks (12month) + user info + monthly counts
  // Note: Last.fm's "12month" period is a rolling window, not calendar year.
  // For years other than current we show totals via monthly sum.
  let [artists, albums, tracks, monthCounts] = await Promise.allSettled([
    getTopArtists(lfmUser, "12month", 5),
    getTopAlbums(lfmUser, "12month", 5),
    getTopTracks(lfmUser, "12month", 5),
    getMonthlyScrobbleCounts(lfmUser, year),
  ]).then(results => results.map(r => r.status === "fulfilled" ? r.value : []));

  const yearTotal    = monthCounts.reduce((s, n) => s + n, 0);
  const peakMonth    = monthCounts.indexOf(Math.max(...monthCounts));
  const activeMonths = monthCounts.filter(n => n > 0).length;
  const avgPerDay    = Math.round(yearTotal / (activeMonths > 0 ? activeMonths * 30 : 365));

  // Monthly bar chart
  const maxCount = Math.max(...monthCounts, 1);
  const barLines = monthCounts.map((n, i) => {
    const pct   = Math.round((n / maxCount) * 10);
    const bar   = "█".repeat(pct) + "░".repeat(10 - pct);
    const label = MONTH_NAMES[i].padEnd(3);
    return `\`${label}\` ${bar} ${n > 0 ? fmtNum(n) : "—"}`;
  });

  const spark = `\`${sparkline(monthCounts)}\` ${year}`;

  // Build artist/album/track lines
  const artistLines = Array.isArray(artists) ? artists.slice(0, 5).map((a, i) =>
    `\`${i + 1}.\` **${truncate(a.name, 28)}** — ${fmtNum(a.playcount)} plays`
  ) : [];

  const albumLines = Array.isArray(albums) ? albums.slice(0, 5).map((a, i) =>
    `\`${i + 1}.\` **${truncate(a.name, 24)}** by ${truncate(a.artist?.name || "?", 18)} — ${fmtNum(a.playcount)}`
  ) : [];

  const trackLines = Array.isArray(tracks) ? tracks.slice(0, 5).map((t, i) =>
    `\`${i + 1}.\` **${truncate(t.name, 24)}** by ${truncate(t.artist?.name || "?", 18)} — ${fmtNum(t.playcount)}`
  ) : [];

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${lfmUser}'s ${year} in review`,
      url: userUrl(lfmUser),
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      [
        `**${fmtNum(yearTotal)}** scrobbles in ${year}`,
        yearTotal > 0 ? `~${fmtNum(avgPerDay)}/day · peak month: **${MONTH_NAMES[peakMonth]}** (${fmtNum(monthCounts[peakMonth])})` : "",
        "",
        spark,
        ...barLines,
      ].filter(l => l !== undefined).join("\n")
    );

  if (artistLines.length) {
    embed.addFields({ name: "Top Artists (last 12 months)", value: artistLines.join("\n"), inline: true });
  }
  if (albumLines.length) {
    embed.addFields({ name: "Top Albums", value: albumLines.join("\n"), inline: true });
  }
  if (trackLines.length) {
    embed.addFields({ name: "Top Tracks", value: trackLines.join("\n"), inline: false });
  }

  const albumArt = Array.isArray(albums) && albums[0] ? getImage(albums[0].image) : null;
  if (albumArt) embed.setThumbnail(albumArt);

  await interaction.editReply({ embeds: [embed] });
}
