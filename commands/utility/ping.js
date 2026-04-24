import { SlashCommandBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check if Eris is alive");

export async function execute(interaction) {
  const ws = interaction.client.ws.ping;
  const sent = await interaction.reply({ content: "pinging...", fetchReply: true });
  const rt = sent.createdTimestamp - interaction.createdTimestamp;
  await interaction.editReply(`pong — ${rt}ms roundtrip, ${ws}ms websocket`);
}
