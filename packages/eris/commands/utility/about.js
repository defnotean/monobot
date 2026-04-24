import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import config from "../../config.js";

export const data = new SlashCommandBuilder()
  .setName("about")
  .setDescription("About Eris");

export async function execute(interaction) {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  const embed = new EmbedBuilder()
    .setColor(config.colors.primary)
    .setTitle("Eris — OpenClaw")
    .setDescription("the chaotic AI assistant with 46 tools and zero chill")
    .addFields(
      { name: "uptime", value: `${h}h ${m}m`, inline: true },
      { name: "memory", value: `${mem}MB`, inline: true },
      { name: "model", value: config.geminiModel, inline: true },
      { name: "guilds", value: `${interaction.client.guilds.cache.size}`, inline: true },
    )
    .setFooter({ text: "built by defnotean" });

  await interaction.reply({ embeds: [embed] });
}
