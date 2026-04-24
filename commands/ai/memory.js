import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed, primaryEmbed } from "../../utils/embeds.js";
import { addMemory, getMemories, removeMemory, clearMemories, searchMemories } from "../../ai/memory.js";
import { paginate } from "../../utils/pagination.js";
import { log } from "../../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("memory")
  .setDescription("Manage memories Irene has about you")
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Show memories about you (or another user if you're an admin)")
      .addUserOption((o) =>
        o.setName("user").setDescription("(Admin only) View memories for another user").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("forget")
      .setDescription("Remove a specific memory by number")
      .addNumberOption((o) =>
        o.setName("index").setDescription("Memory number (from /memory list)").setRequired(true)
      )
      .addUserOption((o) =>
        o.setName("user").setDescription("(Admin only) Remove from another user's memories").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("Clear all memories about you")
      .addUserOption((o) =>
        o.setName("user").setDescription("(Admin only) Clear another user's memories").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("search")
      .setDescription("Search for memories by keyword")
      .addStringOption((o) =>
        o.setName("query").setDescription("Search term").setRequired(true)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

  // Determine which user to manage
  let targetUserId = interaction.user.id;
  const specifiedUser = interaction.options.getUser("user");

  if (specifiedUser) {
    if (!isAdmin) {
      return interaction.reply({
        embeds: [errorEmbed("not authorized", "only admins can view/manage other users' memories")],
        flags: 64,
      });
    }
    targetUserId = specifiedUser.id;
  }

  if (sub === "list") {
    const memories = getMemories(guildId, targetUserId);

    if (memories.length === 0) {
      const targetName = specifiedUser ? `<@${targetUserId}>` : "you";
      return interaction.reply({
        embeds: [infoEmbed("no memories", `i don't have anything saved about ${targetName} yet`)],
        flags: 64,
      });
    }

    const targetName = specifiedUser ? specifiedUser.username : "you";

    // Use pagination if there are many memories
    if (memories.length > 10) {
      return paginate(interaction, {
        items: memories,
        itemsPerPage: 10,
        ephemeral: true,
        formatPage: (items, pageIdx, totalPages) => {
          let text = "";
          const startIdx = pageIdx * 10;
          for (let i = 0; i < items.length; i++) {
            text += `${startIdx + i + 1}. ${items[i].fact}\n`;
          }
          return primaryEmbed(`memories about ${targetName}`, text).setFooter({
            text: `Page ${pageIdx + 1} of ${totalPages}`,
          });
        },
      });
    }

    let text = "";
    for (let i = 0; i < memories.length; i++) {
      text += `${i + 1}. ${memories[i].fact}\n`;
    }

    return interaction.reply({
      embeds: [primaryEmbed(`memories about ${targetName}`, text)],
      flags: 64,
    });
  }

  if (sub === "forget") {
    const index = Math.floor(interaction.options.getNumber("index")) - 1;
    const result = removeMemory(guildId, targetUserId, index);

    if (!result.success) {
      return interaction.reply({
        embeds: [errorEmbed("couldn't remove", result.message)],
        flags: 64,
      });
    }

    log(`[Memory] Removed memory ${index + 1} for user ${targetUserId} in guild ${guildId}`);
    return interaction.reply({
      embeds: [successEmbed("forgotten", `removed memory #${index + 1}`)],
      flags: 64,
    });
  }

  if (sub === "clear") {
    const result = clearMemories(guildId, targetUserId);

    if (!result.success) {
      return interaction.reply({
        embeds: [errorEmbed("error", "couldn't clear memories")],
        flags: 64,
      });
    }

    log(`[Memory] Cleared all memories for user ${targetUserId} in guild ${guildId}`);
    return interaction.reply({
      embeds: [successEmbed("cleared", `all memories about <@${targetUserId}> have been removed`)],
      flags: 64,
    });
  }

  if (sub === "search") {
    const query = interaction.options.getString("query");
    const results = searchMemories(guildId, query);

    if (results.length === 0) {
      return interaction.reply({
        embeds: [infoEmbed("no results", `no memories match "${query}"`)],
        flags: 64,
      });
    }

    // Use pagination if there are many results
    if (results.length > 10) {
      return paginate(interaction, {
        items: results,
        itemsPerPage: 10,
        ephemeral: true,
        formatPage: (items, pageIdx, totalPages) => {
          let text = "";
          const startIdx = pageIdx * 10;
          for (let i = 0; i < items.length; i++) {
            const { userId, memory } = items[i];
            text += `${startIdx + i + 1}. <@${userId}>: ${memory.fact}\n`;
          }
          return primaryEmbed(`search results for "${query}"`, text).setFooter({
            text: `Page ${pageIdx + 1} of ${totalPages} (${results.length} total)`,
          });
        },
      });
    }

    let text = "";
    for (let i = 0; i < results.length; i++) {
      const { userId, memory } = results[i];
      text += `${i + 1}. <@${userId}>: ${memory.fact}\n`;
    }

    return interaction.reply({
      embeds: [primaryEmbed(`search results for "${query}"`, text).setFooter({
        text: `${results.length} total`,
      })],
      flags: 64,
    });
  }
}
