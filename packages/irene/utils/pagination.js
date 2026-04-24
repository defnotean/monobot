// ─── Shared Pagination Helper ───────────────────────────────────────────────
// Creates paginated embeds with forward/back buttons for any list content.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";

/**
 * Build a paginated embed and send it with navigation buttons.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {Object} options
 * @param {Array} options.items - Array of items to paginate
 * @param {number} [options.itemsPerPage=10] - Items per page
 * @param {Function} options.formatPage - (items, pageIndex, totalPages) => EmbedBuilder
 * @param {boolean} [options.ephemeral=false] - Whether the message should be ephemeral
 * @param {number} [options.timeout=120000] - Collector timeout in ms
 */
export async function paginate(interaction, { items, itemsPerPage = 10, formatPage, ephemeral = false, timeout = 120000 }) {
  if (!items || items.length === 0) {
    return formatPage([], 0, 0); // Let caller handle empty state
  }

  const totalPages = Math.ceil(items.length / itemsPerPage);

  // If everything fits on one page, no buttons needed
  if (totalPages === 1) {
    const embed = formatPage(items.slice(0, itemsPerPage), 0, 1);
    const opts = { embeds: [embed] };
    if (ephemeral) opts.flags = 64;
    return interaction.reply(opts);
  }

  let currentPage = 0;

  function getPage() {
    const start = currentPage * itemsPerPage;
    const pageItems = items.slice(start, start + itemsPerPage);
    return formatPage(pageItems, currentPage, totalPages);
  }

  function getButtons() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("page_first")
        .setEmoji("⏮️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId("page_prev")
        .setEmoji("◀️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId("page_indicator")
        .setLabel(`${currentPage + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("page_next")
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages - 1),
      new ButtonBuilder()
        .setCustomId("page_last")
        .setEmoji("⏭️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages - 1)
    );
  }

  const opts = { embeds: [getPage()], components: [getButtons()] };
  if (ephemeral) opts.flags = 64;

  await interaction.reply(opts);
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === interaction.user.id,
    time: timeout,
  });

  collector.on("collect", async (i) => {
    switch (i.customId) {
      case "page_first": currentPage = 0; break;
      case "page_prev": currentPage = Math.max(0, currentPage - 1); break;
      case "page_next": currentPage = Math.min(totalPages - 1, currentPage + 1); break;
      case "page_last": currentPage = totalPages - 1; break;
    }

    await i.update({ embeds: [getPage()], components: [getButtons()] });
  });

  collector.on("end", async () => {
    // Disable all buttons when the collector expires
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("page_first").setEmoji("⏮️").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("page_prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("page_indicator").setLabel(`${currentPage + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("page_next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("page_last").setEmoji("⏭️").setStyle(ButtonStyle.Secondary).setDisabled(true)
    );
    await message.edit({ components: [disabledRow] }).catch(() => {});
  });

  return message;
}

/**
 * Utility: format a duration in milliseconds to human-readable.
 */
export function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000) % 24;
  const days = Math.floor(ms / 86400000);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && days === 0) parts.push(`${seconds}s`);

  return parts.join(" ") || "0s";
}
