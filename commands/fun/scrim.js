import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { activeScrims, buildLobbyEmbed } from "../../utils/scrims.js";
import { getScrimStats } from "../../database.js";
import { errorEmbed } from "../../utils/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("scrim")
  .setDescription("Organize, play, and track ELO for custom scrim matches")
  .addSubcommand(sub => 
    sub.setName("create")
      .setDescription("Host a new scrim lobby")
      .addStringOption(opt => opt.setName("game").setDescription("e.g. Valorant, League, Overwatch").setRequired(true))
      .addIntegerOption(opt => opt.setName("team_size").setDescription("Number of players per team (default: 5)").setMinValue(1).setMaxValue(10))
  )
  .addSubcommand(sub =>
    sub.setName("leaderboard")
      .setDescription("View the ELO leaderboard for a specific game")
      .addStringOption(opt => opt.setName("game").setDescription("The game to view (e.g. Valorant)").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("stats")
      .setDescription("View someone's ELO and match history")
      .addStringOption(opt => opt.setName("game").setDescription("The game to view (e.g. Valorant)").setRequired(true))
      .addUserOption(opt => opt.setName("player").setDescription("The player to view (defaults to you)"))
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "create") {
    const game = interaction.options.getString("game");
    const teamSize = interaction.options.getInteger("team_size") ?? 5;

    // We use a unique ID for the scrim based on the interaction ID (which serves uniquely)
    const scrimId = interaction.id;

    activeScrims.set(scrimId, {
      id: scrimId,
      host: interaction.user.id,
      game: game,
      teamSize: teamSize,
      status: "lobby",
      players: new Set([interaction.user.id]),
      createdAt: Date.now(),
    });

    const payload = buildLobbyEmbed(activeScrims.get(scrimId));
    await interaction.reply(payload);

  } else if (sub === "leaderboard") {
    const game = interaction.options.getString("game");
    const stats = getScrimStats(interaction.guild.id, game);

    const arr = Object.keys(stats).map(uid => ({ id: uid, elo: stats[uid].elo, wins: stats[uid].wins, losses: stats[uid].losses, mvps: stats[uid].mvps || 0 }));
    if (arr.length === 0) {
      return interaction.reply({ embeds: [errorEmbed("No Data", `No scrim matches have been played for **${game}** in this server yet!`)], ephemeral: true });
    }

    arr.sort((a, b) => b.elo - a.elo);
    const top = arr.slice(0, 10);
    const text = top.map((p, i) => `**#${i + 1}** <@${p.id}> — **${p.elo} ELO** (${p.wins}W / ${p.losses}L / ${p.mvps}★)`).join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top 10 Leaderboard: ${game}`)
      .setDescription(text)
      .setColor(0x57F287)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

  } else if (sub === "stats") {
    const game = interaction.options.getString("game");
    const target = interaction.options.getUser("player") || interaction.user;
    const stats = getScrimStats(interaction.guild.id, game);

    const s = stats[target.id];
    if (!s) {
      return interaction.reply({ embeds: [errorEmbed("No Stats", `<@${target.id}> hasn't played any tracked **${game}** scrims yet.`)], ephemeral: true });
    }

    const winrate = (s.wins + s.losses) > 0 ? Math.round((s.wins / (s.wins + s.losses)) * 100) : 0;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Stats: ${target.username} (${game})`)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "ELO Rating", value: `**${s.elo}**`, inline: true },
        { name: "Matches Played", value: `${s.wins + s.losses}`, inline: true },
        { name: "Win Rate", value: `${winrate}% (${s.wins}W / ${s.losses}L)`, inline: true },
        { name: "MVP Awards", value: `⭐ ${s.mvps || 0}`, inline: true }
      )
      .setColor(0x5865F2);

    await interaction.reply({ embeds: [embed] });
  }
}
