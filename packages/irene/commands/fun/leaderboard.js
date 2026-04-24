import { SlashCommandBuilder } from "discord.js";
import { primaryEmbed } from "../../utils/embeds.js";
import { getLeaderboard, getXpData } from "../../utils/leveling.js";
import { paginate } from "../../utils/pagination.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the server's XP leaderboard");

export async function execute(interaction) {
  const leaderboard = getLeaderboard(interaction.guildId, 100);

  if (leaderboard.length === 0) {
    await interaction.reply({
      embeds: [primaryEmbed("Leaderboard", "nothing to show")],
      flags: 64,
    });
    return;
  }

  // Get caller's rank
  const callerXpData = getXpData(interaction.guildId, interaction.user.id);
  const callerRank = leaderboard.findIndex((u) => u.userId === interaction.user.id) + 1;

  // Get medals for top 3
  const medals = ["🥇", "🥈", "🥉"];

  // Format page function for pagination
  const formatPage = (items, pageIndex, totalPages) => {
    let text = "";
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      const globalIndex = pageIndex * 10 + i;
      const medal = globalIndex < 3 ? medals[globalIndex] : `${globalIndex + 1}.`;
      const mention = `<@${entry.userId}>`;
      text += `${medal} ${mention} — Level ${entry.level} (${entry.totalXp} XP)\n`;
    }

    const embed = primaryEmbed("Leaderboard", text);

    if (callerRank > 0) {
      embed.setFooter({
        text: `Your rank: #${callerRank} (Level ${callerXpData.level}, ${callerXpData.totalXp} XP) | Page ${pageIndex + 1}/${totalPages}`,
      });
    } else {
      embed.setFooter({ text: `Page ${pageIndex + 1}/${totalPages}` });
    }

    return embed;
  };

  // Use pagination if more than 10 entries, otherwise just reply
  if (leaderboard.length > 10) {
    await paginate(interaction, {
      items: leaderboard,
      itemsPerPage: 10,
      formatPage,
      ephemeral: false,
      timeout: 120000,
    });
  } else {
    const embed = formatPage(leaderboard, 0, 1);
    await interaction.reply({ embeds: [embed] });
  }
}
