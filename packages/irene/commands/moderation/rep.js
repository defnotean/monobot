import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { infoEmbed, errorEmbed, successEmbed, primaryEmbed } from "../../utils/embeds.js";
import { requireAdminOrOwner } from "../../utils/permissions.js";
import { getWarnings } from "../../database.js";
import { log } from "../../utils/logger.js";
import { paginate } from "../../utils/pagination.js";

// ─── Rep notes: guildId → userId → [{ note, addedBy, addedAt, value: +1 or -1 }, ...] ──
const repNotes = new Map();

export const data = new SlashCommandBuilder()
  .setName("rep")
  .setDescription("View user reputation")
  .addSubcommand((sub) =>
    sub.setName("view").setDescription("View a user's reputation").addUserOption((o) =>
      o.setName("user").setDescription("User to check").setRequired(true)
    )
  )
  .addSubcommand((sub) =>
    sub.setName("history").setDescription("View detailed rep history").addUserOption((o) =>
      o.setName("user").setDescription("User to check").setRequired(true)
    )
  )
  .addSubcommand((sub) =>
    sub
      .setName("note")
      .setDescription("Add a note (admin only)")
      .addUserOption((o) => o.setName("user").setDescription("User to note").setRequired(true))
      .addStringOption((o) =>
        o.setName("note").setDescription("Note text").setRequired(true)
      )
      .addIntegerOption((o) =>
        o
          .setName("value")
          .setDescription("Value: 1 for positive, -1 for negative")
          .setRequired(true)
          .setChoices({ name: "Positive (+1)", value: 1 }, { name: "Negative (-1)", value: -1 })
      )
  )
  .addSubcommand((sub) =>
    sub.setName("leaderboard").setDescription("Show top 10 users by reputation score")
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (subcommand === "view") {
    await handleView(interaction, guildId);
  } else if (subcommand === "history") {
    await handleHistory(interaction, guildId);
  } else if (subcommand === "note") {
    if (!requireAdminOrOwner(interaction)) return;
    await handleNote(interaction, guildId);
  } else if (subcommand === "leaderboard") {
    await handleLeaderboard(interaction, guildId);
  }
}

/**
 * Calculate reputation score for a user
 */
function calculateRepScore(guildId, userId) {
  const warnings = getWarnings(guildId, userId);
  const notes = getNotesForUser(guildId, userId);

  let repScore = 0;
  for (const w of warnings) {
    repScore -= 2; // warning = -2
  }
  for (const n of notes) {
    repScore += n.value;
  }

  return { repScore, warnings, notes };
}

/**
 * View a user's reputation score
 */
async function handleView(interaction, guildId) {
  const user = interaction.options.getUser("user");
  const { repScore, warnings, notes } = calculateRepScore(guildId, user.id);

  // Determine rating based on score
  let rating = "Neutral";
  let ratingEmoji = "➖";
  if (repScore >= 50) { rating = "Excellent"; ratingEmoji = "⭐⭐⭐"; }
  else if (repScore >= 20) { rating = "Good"; ratingEmoji = "⭐⭐"; }
  else if (repScore <= -50) { rating = "Terrible"; ratingEmoji = "🔴🔴🔴"; }
  else if (repScore <= -20) { rating = "Poor"; ratingEmoji = "🔴🔴"; }

  const embed = primaryEmbed("Reputation Summary")
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: "👤 User", value: user.tag, inline: true },
      { name: "⭐ Rep Score", value: `\`${repScore}\``, inline: true },
      { name: "📊 Rating", value: `${ratingEmoji} ${rating}`, inline: true },
      { name: "⚠️ Warnings", value: `${warnings.length}`, inline: true },
      { name: "📝 Notes", value: `${notes.length}`, inline: true },
      { name: "Positive/Negative", value: `${notes.filter(n => n.value > 0).length}/${notes.filter(n => n.value < 0).length}`, inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}

/**
 * View detailed reputation history
 */
async function handleHistory(interaction, guildId) {
  const user = interaction.options.getUser("user");
  const warnings = getWarnings(guildId, user.id);
  const notes = getNotesForUser(guildId, user.id);

  if (warnings.length === 0 && notes.length === 0) {
    return interaction.reply({
      embeds: [errorEmbed("No History", `${user.tag} has no warnings or notes.`)],
      flags: 64,
    });
  }

  // Build history list with timestamps
  const historyItems = [];

  for (const w of warnings) {
    historyItems.push({
      timestamp: new Date(w.created_at).getTime(),
      line: `**⚠️ Warning**: ${w.reason || "*(no reason)*"}\n   > ${new Date(w.created_at).toLocaleDateString()}`,
    });
  }

  for (const n of notes) {
    const icon = n.value > 0 ? "✅" : "❌";
    historyItems.push({
      timestamp: new Date(n.addedAt).getTime(),
      line: `**${icon} Note** (${n.value > 0 ? "Positive" : "Negative"}): ${n.note}\n   > by ${n.addedBy} on ${new Date(n.addedAt).toLocaleDateString()}`,
    });
  }

  // Sort by timestamp descending
  historyItems.sort((a, b) => b.timestamp - a.timestamp);

  await paginate(interaction, {
    items: historyItems,
    itemsPerPage: 10,
    ephemeral: false,
    formatPage: (items, pageIndex, totalPages) => {
      return infoEmbed(`Reputation History — ${user.username}`, items.map(i => i.line).join("\n\n") || "*(none)*")
        .setFooter({ text: `Page ${pageIndex + 1} / ${totalPages} • Total: ${historyItems.length}` });
    },
  });
}

/**
 * Add a reputation note
 */
async function handleNote(interaction, guildId) {
  const user = interaction.options.getUser("user");
  const noteText = interaction.options.getString("note");
  const value = interaction.options.getInteger("value");

  const note = {
    note: noteText,
    addedBy: interaction.user.tag,
    addedAt: new Date().toISOString(),
    value,
  };

  // Store note
  if (!repNotes.has(guildId)) {
    repNotes.set(guildId, new Map());
  }
  const guildNotes = repNotes.get(guildId);
  if (!guildNotes.has(user.id)) {
    guildNotes.set(user.id, []);
  }
  guildNotes.get(user.id).push(note);

  const { repScore } = calculateRepScore(guildId, user.id);

  log(`[Rep] ${interaction.user.tag} added ${value > 0 ? "positive" : "negative"} note to ${user.tag}: ${noteText}`);

  const icon = value > 0 ? "✅" : "❌";
  await interaction.reply({
    embeds: [
      successEmbed(`Note Added — ${icon}`, `Added a ${value > 0 ? "positive" : "negative"} note to ${user.tag}.`)
        .setDescription(noteText)
        .addFields({
          name: "New Rep Score",
          value: `\`${repScore}\``,
          inline: true,
        })
    ],
    flags: 64,
  });
}

/**
 * Show leaderboard of top 10 users by rep score
 */
async function handleLeaderboard(interaction, guildId) {
  // This would require accessing all users in the guild, which isn't straightforward
  // For now, we create a placeholder that shows that this feature requires integration with user tracking

  const leaderboard = [];

  // In a real implementation, you'd iterate through tracked users in the guild
  // For demonstration, we'll show the structure

  if (leaderboard.length === 0) {
    return interaction.reply({
      embeds: [infoEmbed("Reputation Leaderboard", "No reputation data available yet.")],
    });
  }

  await paginate(interaction, {
    items: leaderboard,
    itemsPerPage: 10,
    formatPage: (items, pageIndex, totalPages) => {
      const lines = items.map((entry, idx) => {
        const rank = pageIndex * 10 + idx + 1;
        return `**${rank}.** <@${entry.userId}> — \`${entry.score}\` points`;
      });

      return primaryEmbed("Reputation Leaderboard")
        .setDescription(lines.join("\n") || "*(no data)*")
        .setFooter({ text: `Page ${pageIndex + 1} / ${totalPages}` });
    },
  });
}

/**
 * Get notes for a user
 */
function getNotesForUser(guildId, userId) {
  if (!repNotes.has(guildId)) return [];
  const guildNotes = repNotes.get(guildId);
  return guildNotes.get(userId) ?? [];
}

/**
 * Initialize rep data from database
 */
export function initRepData(loaded) {
  if (loaded?.rep_notes) {
    for (const [guildId, userNotes] of Object.entries(loaded.rep_notes)) {
      const guildMap = new Map();
      for (const [userId, notes] of Object.entries(userNotes)) {
        guildMap.set(userId, notes);
      }
      repNotes.set(guildId, guildMap);
    }
    log(`[Rep] Loaded notes for ${repNotes.size} guilds`);
  }
}

/**
 * Get all rep data for database persistence
 */
export function getRepData() {
  const obj = {};
  for (const [guildId, guildMap] of repNotes) {
    obj[guildId] = {};
    for (const [userId, notes] of guildMap) {
      obj[guildId][userId] = notes;
    }
  }
  return { rep_notes: obj };
}
