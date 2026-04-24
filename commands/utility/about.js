import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("about")
  .setDescription("Learn about Irene");

export async function execute(interaction) {
  const client = interaction.client;

  // Count total users across all guilds
  const totalUsers = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);
  const totalServers = client.guilds.cache.size;
  const totalCommands = client.commands.size;

  // Uptime
  const uptimeMs = client.uptime ?? 0;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const days    = Math.floor(uptimeSec / 86400);
  const hours   = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const uptimeStr = days > 0
    ? `${days}d ${hours}h ${minutes}m`
    : hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes}m`;

  const embed = primaryEmbed("Irene", "Your all-in-one Discord companion — music, moderation, AI chat, and more.")
    .setAuthor({
      name: client.user.username,
      iconURL: client.user.displayAvatarURL({ size: 64 }),
    })
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "🏠  Servers", value: `\`${totalServers}\``, inline: true },
      { name: "👥  Users", value: `\`${totalUsers}\``, inline: true },
      { name: "⚡  Commands", value: `\`${totalCommands}\``, inline: true },
      { name: "🕐  Uptime", value: `\`${uptimeStr}\``, inline: true },
      { name: "🛠️  Built with", value: "discord.js · Node.js", inline: true },
      { name: "✨  Version", value: "`1.0.0`", inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("GitHub")
      .setStyle(ButtonStyle.Link)
      .setURL("https://github.com/placeholder/irene")
      .setEmoji("📦"),
    new ButtonBuilder()
      .setLabel("Invite Irene")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`)
      .setEmoji("📨"),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}
