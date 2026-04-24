// /fmalbums — Show top albums for a time period
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getTopAlbums } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, PERIOD_CHOICES, periodApi, periodLabel, userUrl, getImage, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmalbums")
  .setDescription("Show your top albums")
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
    opt.setName("count").setDescription("Number of albums (1-25)").setMinValue(1).setMaxValue(25).setRequired(false)
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

  let albums;
  try {
    albums = await getTopAlbums(lfmUser, periodApi(period), limit);
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  if (!albums.length) {
    return interaction.editReply(`no scrobbles found for that period`);
  }

  const imageUrl = getImage(albums[0]?.image);

  const lines = albums.map((a, i) => {
    const plays = fmtNum(a.playcount);
    const artist = truncate(a.artist?.name || "?", 22);
    return `\`${String(i + 1).padStart(2)}\` **${truncate(a.name, 28)}** by ${artist} — ${plays} plays`;
  });

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${lfmUser}'s top albums — ${periodLabel(period)}`,
      url: `${userUrl(lfmUser)}/library/albums`,
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setDescription(lines.join("\n"))
    .setThumbnail(imageUrl);

  await interaction.editReply({ embeds: [embed] });
}
