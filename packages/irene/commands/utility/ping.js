import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check bot latency");

export async function execute(interaction) {
  await interaction.reply({ content: "Pinging..." });
  const sent = await interaction.fetchReply();
  const responseTime = sent.createdTimestamp - interaction.createdTimestamp;
  const apiLatency = interaction.client.ws.ping;

  const status = apiLatency < 100
    ? "🟢 Excellent"
    : apiLatency < 200
    ? "🟡 Good"
    : "🔴 Poor";

  await interaction.editReply({
    content: null,
    embeds: [
      primaryEmbed("🏓  Pong!")
        .addFields(
          { name: "API Latency", value: `\`${apiLatency}ms\``, inline: true },
          { name: "Response Time", value: `\`${responseTime}ms\``, inline: true },
          { name: "Status", value: status, inline: true },
        ),
    ],
  });
}
