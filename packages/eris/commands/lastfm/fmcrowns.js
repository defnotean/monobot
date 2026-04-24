// /fmcrowns — View crown standings for this server
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getUserCrowns, getGuildCrownsLeaderboard, getFmUser } from "../../lastfm/db.js";
import { FM_COLOR, truncate, fmtNum } from "../../lastfm/helpers.js";

export const data = new SlashCommandBuilder()
  .setName("fmcrowns")
  .setDescription("View Last.fm crowns — who holds the most-plays crown per artist")
  .addSubcommand(sub =>
    sub.setName("user")
      .setDescription("View a user's crowns")
      .addUserOption(opt =>
        opt.setName("user").setDescription("Member to check (defaults to you)").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName("server")
      .setDescription("Crown leaderboard for this server")
  );

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "this command only works in servers", ephemeral: true });
  }

  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();

  if (sub === "server") {
    const board = await getGuildCrownsLeaderboard(interaction.guild.id);
    if (!board.length) {
      return interaction.editReply("no crowns in this server yet — use `/fmwhoknows` to claim some");
    }

    let members;
    try {
      if (interaction.guild.members.cache.size < (interaction.guild.memberCount * 0.8)) {
        await interaction.guild.members.fetch();
      }
      members = interaction.guild.members.cache;
    } catch {
      members = interaction.guild.members.cache;
    }

    const lines = board.slice(0, 15).map((entry, i) => {
      const member = members.get(entry.discord_id);
      const name = member?.displayName || entry.discord_id;
      const crowns = entry.crown_count;
      return `\`${String(i + 1).padStart(2)}\` **${truncate(name, 26)}** — ${crowns} crown${crowns === 1 ? "" : "s"}`;
    });

    const embed = new EmbedBuilder()
      .setColor(FM_COLOR)
      .setTitle(`👑 Crown Leaderboard — ${interaction.guild.name}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `${board.length} crown holders total` });

    return interaction.editReply({ embeds: [embed] });
  }

  // sub === "user"
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

  const crowns = await getUserCrowns(interaction.guild.id, target.id);

  if (!crowns.length) {
    const self = target.id === interaction.user.id;
    return interaction.editReply(
      self
        ? "you don't have any crowns yet — use `/fmwhoknows` on artists you listen to"
        : `${target.displayName || target.username} doesn't have any crowns in this server`
    );
  }

  const lines = crowns.slice(0, 20).map((c, i) => {
    return `\`${String(i + 1).padStart(2)}\` **${truncate(c.artist_name, 30)}** — ${fmtNum(c.play_count)} plays`;
  });

  const embed = new EmbedBuilder()
    .setColor(FM_COLOR)
    .setAuthor({
      name: `${linked.lastfm_username}'s crowns — ${interaction.guild.name}`,
      iconURL: target.displayAvatarURL({ size: 64 }),
    })
    .setDescription(lines.join("\n"))
    .setFooter({ text: `👑 ${crowns.length} crown${crowns.length === 1 ? "" : "s"}` });

  await interaction.editReply({ embeds: [embed] });
}
