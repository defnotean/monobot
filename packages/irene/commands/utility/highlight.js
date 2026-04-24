import { SlashCommandBuilder } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";
import { saveHighlightDb } from "../../database.js";

// ── Highlight Store ────────────────────────────────────────────────────────────
// Key: `guildId-userId`, Value: Set of words to highlight
export const highlightStore = new Map();

// ── Activity Tracking (prevent spam) ───────────────────────────────────────────
// Key: `guildId-userId`, Value: timestamp of last message
const lastSeenActivity = new Map();
const ACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ── Notification Cooldown (prevent DM spam) ────────────────────────────────────
// Key: `guildId-userId-word`, Value: timestamp of last notification
const notificationCooldown = new Map();
const NOTIFICATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ── Utility Functions ──────────────────────────────────────────────────────────

function getHighlights(guildId, userId) {
  const key = `${guildId}-${userId}`;
  return highlightStore.get(key) || new Set();
}

function _persistHighlights() {
  saveHighlightDb(getHighlightData());
}

function setHighlights(guildId, userId, words) {
  const key = `${guildId}-${userId}`;
  if (words.size === 0) {
    highlightStore.delete(key);
  } else {
    highlightStore.set(key, words);
  }
  _persistHighlights();
}

function addHighlight(guildId, userId, word) {
  const key = `${guildId}-${userId}`;
  const words = getHighlights(guildId, userId);

  if (words.size >= 10) return false; // max 10 highlights
  if (word.length > 32) return false; // max 32 chars per word

  words.add(word.toLowerCase());
  setHighlights(guildId, userId, words);
  return true;
}

function removeHighlight(guildId, userId, word) {
  const key = `${guildId}-${userId}`;
  const words = getHighlights(guildId, userId);
  const removed = words.delete(word.toLowerCase());
  setHighlights(guildId, userId, words);
  return removed;
}

function clearHighlights(guildId, userId) {
  const key = `${guildId}-${userId}`;
  highlightStore.delete(key);
  _persistHighlights();
}

// ── Track user activity in guild ───────────────────────────────────────────────
function recordActivity(guildId, userId) {
  const key = `${guildId}-${userId}`;
  lastSeenActivity.set(key, Date.now());
}

function isRecentlyActive(guildId, userId) {
  const key = `${guildId}-${userId}`;
  const lastSeen = lastSeenActivity.get(key);
  if (!lastSeen) return false;
  return Date.now() - lastSeen < ACTIVITY_TIMEOUT;
}

// ── Check if notification is on cooldown ───────────────────────────────────────
function isOnNotificationCooldown(guildId, userId, word) {
  const key = `${guildId}-${userId}-${word}`;
  const lastNotified = notificationCooldown.get(key);
  if (!lastNotified) return false;
  return Date.now() - lastNotified < NOTIFICATION_TIMEOUT;
}

function recordNotification(guildId, userId, word) {
  const key = `${guildId}-${userId}-${word}`;
  notificationCooldown.set(key, Date.now());
}

// ── Check message for highlights ───────────────────────────────────────────────
// Notifies users (via DM) when their registered words are mentioned
export async function checkHighlights(message) {
  if (!message.author || message.author.bot || !message.guild) return;

  // Record activity for the message author
  recordActivity(message.guild.id, message.author.id);

  const messageContent = message.content.toLowerCase();

  // Find all users with highlights in this guild
  for (const [key, words] of highlightStore.entries()) {
    const [guildId, userId] = key.split("-");

    // Skip if not in this guild
    if (guildId !== message.guild.id) continue;

    // Skip if it's the author's own message
    if (userId === message.author.id) continue;

    // Skip if user hasn't been active in last 5 minutes (prevent spam for lurkers)
    if (!isRecentlyActive(guildId, userId)) continue;

    // Check if any highlighted words are in the message
    let foundWord = null;
    for (const word of words) {
      // Escape regex special chars so user-provided words like "c++" or "(test)" don't crash
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(messageContent)) {
        foundWord = word;
        break;
      }
    }

    if (foundWord) {
      // Skip if on notification cooldown for this word
      if (isOnNotificationCooldown(guildId, userId, foundWord)) continue;

      try {
        const user = await message.client.users.fetch(userId);
        const preview = message.content.length > 100
          ? message.content.substring(0, 97) + "..."
          : message.content;

        const embed = infoEmbed(
          `Highlight: \`${foundWord}\``,
          preview
        )
          .addFields(
            { name: "Channel", value: `#${message.channel.name}`, inline: true },
            { name: "Author", value: message.author.username, inline: true },
            { name: "Jump to Message", value: `[Click here](${message.url})`, inline: false }
          )
          .setColor(0x7C3AED);

        await user.send({ embeds: [embed] });
        recordNotification(guildId, userId, foundWord);
      } catch (err) {
        log(`[Highlight] Failed to DM ${userId}: ${err.message}`);
      }
    }
  }
}

// ── Command ────────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("highlight")
  .setDescription("Manage words you want to be notified about")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a word to highlight")
      .addStringOption((o) =>
        o.setName("word")
          .setDescription("Word to highlight")
          .setRequired(true)
          .setMaxLength(32)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove a highlighted word")
      .addStringOption((o) =>
        o.setName("word")
          .setDescription("Word to remove")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list")
      .setDescription("List all your highlighted words")
  )
  .addSubcommand((sub) =>
    sub.setName("clear")
      .setDescription("Clear all highlighted words")
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "add") {
    const word = interaction.options.getString("word");

    if (addHighlight(interaction.guild.id, interaction.user.id, word)) {
      await interaction.reply({
        embeds: [successEmbed("Highlight Added", `now watching for: \`${word}\``)],
        flags: 64,
      });
      recordActivity(interaction.guild.id, interaction.user.id);
    } else {
      await interaction.reply({
        embeds: [errorEmbed("Highlight Limit", "you can have a maximum of 10 highlights")],
        flags: 64,
      });
    }
  } else if (subcommand === "remove") {
    const word = interaction.options.getString("word");

    if (removeHighlight(interaction.guild.id, interaction.user.id, word)) {
      await interaction.reply({
        embeds: [successEmbed("Highlight Removed", `no longer watching for: \`${word}\``)],
        flags: 64,
      });
    } else {
      await interaction.reply({
        embeds: [errorEmbed("Not Found", `you don't have \`${word}\` highlighted`)],
        flags: 64,
      });
    }
  } else if (subcommand === "list") {
    const words = Array.from(getHighlights(interaction.guild.id, interaction.user.id));

    if (words.length === 0) {
      await interaction.reply({
        embeds: [infoEmbed("No Highlights", "you don't have any highlights yet")],
        flags: 64,
      });
    } else {
      await interaction.reply({
        embeds: [
          infoEmbed("Your Highlights", words.map((w) => `\`${w}\``).join(", "))
            .setFooter({ text: `${words.length}/10 highlights` })
        ],
        flags: 64,
      });
    }
  } else if (subcommand === "clear") {
    clearHighlights(interaction.guild.id, interaction.user.id);

    await interaction.reply({
      embeds: [successEmbed("Highlights Cleared", "all highlights have been removed")],
      flags: 64,
    });
  }
}

// ── Export for database integration ────────────────────────────────────────────

export function initHighlightData(loaded) {
  if (loaded && loaded.highlights) {
    highlightStore.clear();
    lastSeenActivity.clear();
    notificationCooldown.clear();

    Object.entries(loaded.highlights).forEach(([key, words]) => {
      highlightStore.set(key, new Set(words));
    });

    if (loaded.last_seen_activity) {
      Object.entries(loaded.last_seen_activity).forEach(([key, timestamp]) => {
        lastSeenActivity.set(key, timestamp);
      });
    }

    log(`[Highlight] Loaded highlights for ${highlightStore.size} users`);
  }
}

export function getHighlightData() {
  const highlights = {};
  const lastSeenActivities = {};

  highlightStore.forEach((words, key) => {
    highlights[key] = Array.from(words);
  });

  lastSeenActivity.forEach((timestamp, key) => {
    lastSeenActivities[key] = timestamp;
  });

  return { highlights, last_seen_activity: lastSeenActivities };
}
