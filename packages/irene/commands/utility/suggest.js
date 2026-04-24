import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { successEmbed, errorEmbed, primaryEmbed } from "../../utils/embeds.js";
import { requirePermission, requireAdminOrOwner } from "../../utils/permissions.js";
import { checkCooldown, resetCooldown } from "../../utils/cooldown.js";
import { log } from "../../utils/logger.js";

// ─── Suggestion data storage ────────────────────────────────────────────────
// guildId → { channelId, suggestions: [{ id, messageId, authorId, text, status, reason? }] }
const suggestionData = new Map();

const SUGGESTION_COOLDOWN_MS = 60 * 1000; // 60 seconds

const STATUS_BADGES = {
  pending: "🟡",
  approved: "🟢",
  denied: "🔴",
};

export const data = new SlashCommandBuilder()
  .setName("suggest")
  .setDescription("Manage suggestions")
  .addSubcommand((sub) =>
    sub
      .setName("idea")
      .setDescription("Submit a suggestion")
      .addStringOption((o) => o.setName("idea").setDescription("Your suggestion").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("setup")
      .setDescription("Set the suggestion channel (admin only)")
      .addChannelOption((o) => o.setName("channel").setDescription("Suggestion channel").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("approve")
      .setDescription("Approve a suggestion (admin only)")
      .addIntegerOption((o) => o.setName("number").setDescription("Suggestion number").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Approval reason"))
  )
  .addSubcommand((sub) =>
    sub
      .setName("deny")
      .setDescription("Deny a suggestion (admin only)")
      .addIntegerOption((o) => o.setName("number").setDescription("Suggestion number").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Denial reason"))
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "idea") {
    await handleIdea(interaction);
  } else if (subcommand === "setup") {
    await handleSetup(interaction);
  } else if (subcommand === "approve") {
    await handleApprove(interaction);
  } else if (subcommand === "deny") {
    await handleDeny(interaction);
  }
}

async function handleIdea(interaction) {
  const idea = interaction.options.getString("idea");

  // Check cooldown
  const cooldownCheck = checkCooldown("suggest", interaction.user.id, SUGGESTION_COOLDOWN_MS);
  if (cooldownCheck.onCooldown) {
    return interaction.reply({
      embeds: [errorEmbed("On Cooldown", `please wait ${Math.ceil(cooldownCheck.remaining / 1000)}s before submitting another suggestion`)],
      flags: 64,
    });
  }

  // Validate suggestion length
  if (idea.length < 10) {
    return interaction.reply({
      embeds: [errorEmbed("Too Short", "suggestion must be at least 10 characters long")],
      flags: 64,
    });
  }

  if (idea.length > 1000) {
    return interaction.reply({
      embeds: [errorEmbed("Too Long", "suggestion must be max 1000 characters long")],
      flags: 64,
    });
  }

  const guildData = suggestionData.get(interaction.guildId) || { channelId: null, suggestions: [] };
  let channelId = guildData.channelId;

  // Fall back to current channel if no suggestion channel configured
  if (!channelId) {
    channelId = interaction.channelId;
  }

  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) {
    return interaction.reply({
      embeds: [errorEmbed("suggestion channel not found", "ask an admin to set up the suggestion channel")],
      flags: 64,
    });
  }

  const suggestionNumber = guildData.suggestions.length + 1;

  const embed = new EmbedBuilder()
    .setTitle(`Suggestion #${suggestionNumber}`)
    .setDescription(idea)
    .setColor(0xFDE047)
    .addFields(
      { name: "Status", value: `${STATUS_BADGES.pending} Pending`, inline: true },
      { name: "Author", value: interaction.user.toString(), inline: true },
      { name: "ID", value: `#${suggestionNumber}`, inline: true }
    )
    .setTimestamp();

  try {
    const msg = await channel.send({ embeds: [embed] });

    // Add reactions
    await msg.react("👍").catch(() => {});
    await msg.react("👎").catch(() => {});

    // Store suggestion
    if (!suggestionData.has(interaction.guildId)) {
      suggestionData.set(interaction.guildId, { channelId, suggestions: [] });
    }

    const data = suggestionData.get(interaction.guildId);
    data.suggestions.push({
      id: suggestionNumber,
      messageId: msg.id,
      authorId: interaction.user.id,
      text: idea,
      status: "pending",
      reason: null,
    });

    await interaction.reply({
      embeds: [successEmbed("Suggestion Submitted", `your suggestion #${suggestionNumber} has been posted`)],
      flags: 64,
    });

    // Set cooldown
    resetCooldown("suggest", interaction.user.id);
    checkCooldown("suggest", interaction.user.id, SUGGESTION_COOLDOWN_MS);

    log(`[Suggestion] #${suggestionNumber} submitted in ${interaction.guild.name} by ${interaction.user.tag}`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed("Failed to Post Suggestion", error.message)],
      flags: 64,
    });
  }
}

async function handleSetup(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const channel = interaction.options.getChannel("channel");

  if (!channel.isTextBased()) {
    return interaction.reply({
      embeds: [errorEmbed("Invalid Channel", "the channel must be text-based")],
      flags: 64,
    });
  }

  // Initialize or update data
  if (!suggestionData.has(interaction.guildId)) {
    suggestionData.set(interaction.guildId, { channelId: channel.id, suggestions: [] });
  } else {
    suggestionData.get(interaction.guildId).channelId = channel.id;
  }

  await interaction.reply({
    embeds: [successEmbed("Suggestion Channel Set", `suggestions will now be posted to ${channel}`)],
    flags: 64,
  });

  log(`[Suggestion] Setup in ${interaction.guild.name}: suggestion channel set to #${channel.name}`);
}

async function handleApprove(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const number = interaction.options.getInteger("number");
  const reason = interaction.options.getString("reason") || "No reason provided";

  const guildData = suggestionData.get(interaction.guildId);
  if (!guildData || !guildData.suggestions.length) {
    return interaction.reply({
      embeds: [errorEmbed("No Suggestions Found", "there are no suggestions in this server")],
      flags: 64,
    });
  }

  const suggestion = guildData.suggestions.find((s) => s.id === number);
  if (!suggestion) {
    return interaction.reply({
      embeds: [errorEmbed("Suggestion Not Found", `suggestion #${number} does not exist`)],
      flags: 64,
    });
  }

  try {
    const channel = interaction.guild.channels.cache.get(guildData.channelId);
    if (!channel || !channel.isTextBased()) {
      return interaction.reply({
        embeds: [errorEmbed("Suggestion Channel Not Found", "the suggestion channel may have been deleted")],
        flags: 64,
      });
    }

    const msg = await channel.messages.fetch(suggestion.messageId).catch(() => null);
    if (!msg) {
      suggestion.status = "approved";
      suggestion.reason = reason;

      return interaction.reply({
        embeds: [errorEmbed("Message Not Found", "the suggestion message could not be found")],
        flags: 64,
      });
    }

    // Update embed
    const embed = msg.embeds[0];
    const newEmbed = EmbedBuilder.from(embed)
      .setColor(0x10B981)
      .spliceFields(0, 1, { name: "Status", value: `${STATUS_BADGES.approved} Approved`, inline: true });

    if (reason && reason !== "No reason provided") {
      newEmbed.addFields({ name: "Approval Reason", value: reason, inline: false });
    }

    await msg.edit({ embeds: [newEmbed] }).catch(() => {});

    // Update data
    suggestion.status = "approved";
    suggestion.reason = reason;

    await interaction.reply({
      embeds: [successEmbed("Suggestion Approved", `suggestion #${number} marked as approved`)],
      flags: 64,
    });

    log(`[Suggestion] #${number} approved in ${interaction.guild.name} by ${interaction.user.tag}`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed("Failed to Approve Suggestion", error.message)],
      flags: 64,
    });
  }
}

async function handleDeny(interaction) {
  if (!requireAdminOrOwner(interaction)) return;

  const number = interaction.options.getInteger("number");
  const reason = interaction.options.getString("reason") || "No reason provided";

  const guildData = suggestionData.get(interaction.guildId);
  if (!guildData || !guildData.suggestions.length) {
    return interaction.reply({
      embeds: [errorEmbed("No Suggestions Found", "there are no suggestions in this server")],
      flags: 64,
    });
  }

  const suggestion = guildData.suggestions.find((s) => s.id === number);
  if (!suggestion) {
    return interaction.reply({
      embeds: [errorEmbed("Suggestion Not Found", `suggestion #${number} does not exist`)],
      flags: 64,
    });
  }

  try {
    const channel = interaction.guild.channels.cache.get(guildData.channelId);
    if (!channel || !channel.isTextBased()) {
      return interaction.reply({
        embeds: [errorEmbed("Suggestion Channel Not Found", "the suggestion channel may have been deleted")],
        flags: 64,
      });
    }

    const msg = await channel.messages.fetch(suggestion.messageId).catch(() => null);
    if (!msg) {
      suggestion.status = "denied";
      suggestion.reason = reason;

      return interaction.reply({
        embeds: [errorEmbed("Message Not Found", "the suggestion message could not be found")],
        flags: 64,
      });
    }

    // Update embed
    const embed = msg.embeds[0];
    const newEmbed = EmbedBuilder.from(embed)
      .setColor(0xEF4444)
      .spliceFields(0, 1, { name: "Status", value: `${STATUS_BADGES.denied} Denied`, inline: true });

    if (reason && reason !== "No reason provided") {
      newEmbed.addFields({ name: "Denial Reason", value: reason, inline: false });
    }

    await msg.edit({ embeds: [newEmbed] }).catch(() => {});

    // Update data
    suggestion.status = "denied";
    suggestion.reason = reason;

    await interaction.reply({
      embeds: [successEmbed("Suggestion Denied", `suggestion #${number} marked as denied`)],
      flags: 64,
    });

    log(`[Suggestion] #${number} denied in ${interaction.guild.name} by ${interaction.user.tag}`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed("Failed to Deny Suggestion", error.message)],
      flags: 64,
    });
  }
}

export function initSuggestionData(loaded) {
  suggestionData.clear();
  if (loaded && typeof loaded === "object") {
    for (const [guildId, data] of Object.entries(loaded)) {
      suggestionData.set(guildId, {
        channelId: data.channelId,
        suggestions: data.suggestions || [],
      });
    }
  }
}

export function getSuggestionData() {
  const data = {};
  for (const [guildId, guildData] of suggestionData.entries()) {
    data[guildId] = {
      channelId: guildData.channelId,
      suggestions: guildData.suggestions,
    };
  }
  return data;
}
