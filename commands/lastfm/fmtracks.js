// /fmtracks — Show top tracks for a time period
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTopTracks } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, PERIOD_CHOICES, periodApi, periodLabel, userUrl, getImage, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmtracks")
  .setDescription("Show your top tracks")
  .addStringOption(opt =>
    opt.setName("period")
      .setDescription("Time period")
      .addChoices(...PERIOD_CHOICES)
      .setRequired(false)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Another server member").setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName("count").setDescription("Number of tracks (1-25)").setMinValue(1).setMaxValue(25).setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const target = interaction.options.getUser("user") || interaction.user;
  const period = interaction.options.getString("period") || "all";
  const limit  = interaction.options.getInteger("count") || 10;
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

  let tracks;
  try {
    tracks = await getTopTracks(lfmUser, periodApi(period), limit);
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  if (!tracks.length) {
    return interaction.editReply(`no scrobbles found for that period`);
  }

  const imageUrl = getImage(tracks[0]?.image);

  const lines = tracks.map((t, i) => {
    const plays = fmtNum(t.playcount);
    const artist = truncate(t.artist?.name || "?", 22);
    return `\`${String(i + 1).padStart(2)}\` **${truncate(t.name, 28)}** by ${artist} — ${plays} plays`;
  });

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${lfmUser}'s top tracks — ${periodLabel(period)}`,
      url: `${userUrl(lfmUser)}/library/tracks`,
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setDescription(lines.join("\n"))
    .setThumbnail(imageUrl);

  await interaction.editReply({ embeds: [embed] });
}
