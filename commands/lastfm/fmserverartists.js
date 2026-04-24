// /fmserverartists — Top artists across all linked server members
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getLinkedMembers, getServerTopArtists } from "../../lastfm/db.js";
import { FM_COLOR, fmtNum, truncate } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmserverartists")
  .setDescription("Top artists across all linked members in this server")
  .addIntegerOption(opt =>
    opt.setName("count").setDescription("Number of results (1-20)").setMinValue(1).setMaxValue(20).setRequired(false)
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  await interaction.deferReply();

  // Fetch guild member IDs
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
  const limit = interaction.options.getInteger("count") || 10;

  const linked = await getLinkedMembers(memberIds);
  if (!linked.length) {
    return interaction.editReply("nobody in this server has linked their last.fm yet — use `/fmset username` to get started");
  }

  const linkedIds = linked.map(l => l.discord_id);
  const results   = await getServerTopArtists(linkedIds, limit);

  if (!results.length) {
    return interaction.editReply("no indexed data yet — members need to use `/fm` or `/fmset` to populate the data");
  }

  const lines = results.map((r, i) =>
    `\`${String(i + 1).padStart(2)}\` **${truncate(r.artist_name, 30)}** — ${fmtNum(r.total)} plays · ${r.listeners} listener${r.listeners === 1 ? "" : "s"}`
  );

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setTitle(`Top Artists — ${interaction.guild.name}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `${linked.length} linked member${linked.length === 1 ? "" : "s"} · data from /fmset index` });

  await interaction.editReply({ embeds: [embed] });
}
