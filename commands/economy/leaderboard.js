import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getLeaderboard } from "../../database.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("See the richest users");

export async function execute(interaction) {
  const top = await getLeaderboard(10);
  if (!top.length) return interaction.reply("no one has coins yet lol");

  const lines = await Promise.all(top.map(async (entry, i) => {
    const medals = ["🥇", "🥈", "🥉"];
    const prefix = medals[i] || `**${i + 1}.**`;
    try {
      const user = await interaction.client.users.fetch(entry.user_id);
      return `${prefix} ${user.username} — **${entry.balance?.toLocaleString()}** coins`;
    } catch {
      return `${prefix} Unknown — **${entry.balance?.toLocaleString()}** coins`;
    }
  }));

  const embed = new EmbedBuilder()
    .setTitle("💰 Coin Leaderboard")
    .setDescription(lines.join("\n"))
    .setColor(0x9333EA);

  await interaction.reply({ embeds: [embed] });
}
