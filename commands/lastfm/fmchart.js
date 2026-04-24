// /fmchart — Generate an album art grid chart
import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { getTopAlbums, getTopArtists } from "../../lastfm/api.js";
import { getFmUser } from "../../lastfm/db.js";
import { generateChart } from "../../lastfm/chart.js";
import { FM_COLOR, PERIOD_CHOICES, periodApi, periodLabel, getImage, userUrl, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmchart")
  .setDescription("Generate a grid chart of your top album/artist art")
  .addStringOption(opt =>
    opt.setName("type")
      .setDescription("Chart type")
      .addChoices(
        { name: "Albums (default)", value: "albums" },
        { name: "Artists", value: "artists" },
      )
      .setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName("size")
      .setDescription("Grid size (3=3×3, 4=4×4, 5=5×5)")
      .addChoices(
        { name: "3×3 (9 items)", value: 3 },
        { name: "4×4 (16 items)", value: 4 },
        { name: "5×5 (25 items)", value: 5 },
      )
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("period")
      .setDescription("Time period")
      .addChoices(...PERIOD_CHOICES)
      .setRequired(false)
  )
  .addBooleanOption(opt =>
    opt.setName("labels").setDescription("Show artist/album names on the chart").setRequired(false)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Another server member").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const target   = interaction.options.getUser("user") || interaction.user;
  const type     = interaction.options.getString("type")    || "albums";
  const size     = interaction.options.getInteger("size")   || 3;
  const period   = interaction.options.getString("period")  || "all";
  const labels   = interaction.options.getBoolean("labels") ?? false;
  const limit    = size * size;
  const linked   = await getFmUser(target.id);

  if (!linked) {
    const self = target.id === interaction.user.id;
    return interaction.editReply(
      self
        ? "you haven't linked your last.fm yet — use `/fmset username <your username>`"
        : `${target.username} hasn't linked their last.fm`
    );
  }

  const lfmUser = linked.lastfm_username;

  let items;
  try {
    if (type === "artists") {
      const artists = await getTopArtists(lfmUser, periodApi(period), limit);
      items = artists.map(a => ({
        image: getImage(a.image),
        label: a.name,
      }));
    } else {
      const albums = await getTopAlbums(lfmUser, periodApi(period), limit);
      items = albums.map(a => ({
        image: getImage(a.image),
        label: `${truncate(a.name, 20)} — ${truncate(a.artist?.name || "", 16)}`,
      }));
    }
  } catch (err) {
    return interaction.editReply(`last.fm error: ${err.message}`);
  }

  if (!items.length) {
    return interaction.editReply("not enough scrobbles to generate a chart for that period");
  }

  // Pad to fill the grid if needed
  while (items.length < limit) items.push({ image: null, label: "" });

  let chartBuffer;
  try {
    chartBuffer = await generateChart(items.slice(0, limit), size, labels);
  } catch (err) {
    return interaction.editReply(`chart generation failed: ${err.message}`);
  }

  const attachment = new AttachmentBuilder(chartBuffer, { name: "chart.png" });
  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${lfmUser}'s top ${type} — ${size}×${size} · ${periodLabel(period)}`,
      url: `${userUrl(lfmUser)}/library/${type}`,
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setImage("attachment://chart.png");

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}
