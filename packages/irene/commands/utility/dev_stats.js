import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import os from "os";
import config from "../../config.js";

function formatUptime(ms) {
  const d = Math.floor(ms / (1000 * 60 * 60 * 24));
  const h = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const m = Math.floor((ms / 1000 / 60) % 60);
  const s = Math.floor((ms / 1000) % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

export const data = new SlashCommandBuilder()
  .setName("dev_stats")
  .setDescription("Show internal bot statistics and uptime (Owner only)");

export async function execute(interaction) {
  const client = interaction.client;
  if (interaction.user.id !== config.ownerId) {
    return interaction.reply({ content: "nah, this is for my dev only.", ephemeral: true });
  }

  const memory = process.memoryUsage();
  const memoryMB = (memory.heapUsed / 1024 / 1024).toFixed(2);
  const totalMB = (memory.heapTotal / 1024 / 1024).toFixed(2);
  
  const embed = new EmbedBuilder()
    .setTitle("💻 Developer Statistics")
    .setColor(config.colors.info)
    .addFields(
      { name: "Ping", value: `${client.ws.ping}ms`, inline: true },
      { name: "Uptime", value: formatUptime(client.uptime), inline: true },
      { name: "Memory (Heap)", value: `${memoryMB} MB / ${totalMB} MB`, inline: true },
      { name: "Guilds Cache", value: `${client.guilds.cache.size}`, inline: true },
      { name: "Users Cache", value: `${client.users.cache.size}`, inline: true },
      { name: "Channels Cache", value: `${client.channels.cache.size}`, inline: true },
      { name: "Host OS", value: `${os.type()} ${os.release()}`, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });

  // Debug payload tracking for voice channel
  const vc = interaction.member.voice?.channel;
  if (vc) {
    let debugText = `**Raw Activities for members in ${vc.name}:**\n`;
    for (const [, m] of vc.members) {
      if (m.user.bot) continue;
      const acts = m.presence?.activities || [];
      const actPayloads = acts.map(a => 
        `{ type: ${a.type}, name: "${a.name}", state: "${a.state}", details: "${a.details}" }`
      ).join("\n  ");
      debugText += `- **${m.user.username}**: \n  ${actPayloads || "No activities or presence is null"}\n`;
    }
    await interaction.followUp({ content: debugText, ephemeral: true });
  }
}
