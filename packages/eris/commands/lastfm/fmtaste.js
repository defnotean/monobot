// /fmtaste — Compare music taste compatibility between two users
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTopArtists } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, userUrl, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmtaste")
  .setDescription("Compare music taste between you and another user")
  .addUserOption(opt =>
    opt.setName("user").setDescription("User to compare with").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("period")
      .setDescription("Time period")
      .addChoices(
        { name: "All Time (default)", value: "overall" },
        { name: "Last Month", value: "1month" },
        { name: "Last 3 Months", value: "3month" },
        { name: "Last 6 Months", value: "6month" },
        { name: "Last Year", value: "12month" },
      )
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const other = interaction.options.getUser("user");
  const period = interaction.options.getString("period") || "overall";

  if (other.id === interaction.user.id) {
    return interaction.editReply("comparing yourself with yourself — 100% compatible, obviously");
  }

  const [linkedA, linkedB] = await Promise.all([
    getFmUser(interaction.user.id),
    getFmUser(other.id),
  ]);

  if (!linkedA) {
    return interaction.editReply("you haven't linked your last.fm yet — use `/fmset username`");
  }
  if (!linkedB) {
    return interaction.editReply(`${other.username} hasn't linked their last.fm`);
  }

  let artistsA, artistsB;
  try {
    [artistsA, artistsB] = await Promise.all([
      getTopArtists(linkedA.lastfm_username, period, 100),
      getTopArtists(linkedB.lastfm_username, period, 100),
    ]);
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  if (!artistsA.length || !artistsB.length) {
    return interaction.editReply("not enough scrobbles to compare — try a different time period");
  }

  // Build maps for comparison
  const mapA = new Map(artistsA.map(a => [a.name.toLowerCase(), a]));
  const mapB = new Map(artistsB.map(a => [a.name.toLowerCase(), a]));

  const shared = [];
  for (const [key, a] of mapA) {
    if (mapB.has(key)) shared.push({ name: a.name, playsA: parseInt(a.playcount), playsB: parseInt(mapB.get(key).playcount) });
  }

  // Compatibility score: Jaccard-inspired (shared / union) weighted by rank
  const totalUnique = new Set([...mapA.keys(), ...mapB.keys()]).size;
  const jaccard = totalUnique > 0 ? shared.length / totalUnique : 0;
  const compatScore = Math.round(jaccard * 100);

  // Sort shared artists by combined plays
  shared.sort((a, b) => (b.playsA + b.playsB) - (a.playsA + a.playsB));
  const topShared = shared.slice(0, 8);

  const periodLabel = {
    overall: "All Time", "1month": "Last Month", "3month": "Last 3 Months",
    "6month": "Last 6 Months", "12month": "Last Year",
  }[period] || "All Time";

  const compatEmoji =
    compatScore >= 80 ? "💜" :
    compatScore >= 60 ? "💙" :
    compatScore >= 40 ? "💚" :
    compatScore >= 20 ? "💛" : "🖤";

  const sharedLines = topShared.map(a =>
    `**${truncate(a.name, 24)}** — ${fmtNum(a.playsA)} / ${fmtNum(a.playsB)} plays`
  );

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setTitle(`${compatEmoji} Taste Compatibility — ${compatScore}%`)
    .setDescription(
      `**[${linkedA.lastfm_username}](${userUrl(linkedA.lastfm_username)})** vs **[${linkedB.lastfm_username}](${userUrl(linkedB.lastfm_username)})**\n` +
      `${periodLabel} · ${shared.length} shared artists out of ${totalUnique} unique`
    )
    .addFields({
      name: "Top Shared Artists",
      value: sharedLines.length ? sharedLines.join("\n") : "no shared artists",
      inline: false,
    })
    .setFooter({ text: `${linkedA.lastfm_username} plays / ${linkedB.lastfm_username} plays` });

  await interaction.editReply({ embeds: [embed] });
}
