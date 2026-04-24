import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { primaryEmbed, successEmbed, errorEmbed } from "../../utils/embeds.js";
import { log } from "../../utils/logger.js";

// ─── Active polls Map ───────────────────────────────────────────────────────
// messageId → { question, options[], votes: Map<userId, optionIndex>, endsAt?, anonymous, hostId, guildId, channelId }
const activePolls = new Map();
let checkPollsInterval = null;

const OPTION_LABELS = ["A", "B", "C", "D"];
const OPTION_EMOJIS = ["🇦", "🇧", "🇨", "🇩"];

// ─── Duration parsing ───────────────────────────────────────────────────────
function parseDuration(str) {
  const matches = str.match(/(\d+)([smhd])/gi);
  if (!matches) return null;

  let ms = 0;
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

  for (const match of matches) {
    const num = parseInt(match.slice(0, -1));
    const unit = match.slice(-1).toLowerCase();
    ms += num * (units[unit] || 0);
  }

  return ms > 0 ? ms : null;
}

export const data = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("Create an advanced poll with buttons")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a new poll")
      .addStringOption((o) => o.setName("question").setDescription("Poll question").setRequired(true))
      .addStringOption((o) => o.setName("option1").setDescription("Option A").setRequired(true))
      .addStringOption((o) => o.setName("option2").setDescription("Option B").setRequired(true))
      .addStringOption((o) => o.setName("option3").setDescription("Option C"))
      .addStringOption((o) => o.setName("option4").setDescription("Option D"))
      .addStringOption((o) => o.setName("duration").setDescription("Auto-close duration (e.g., 1h, 30m)"))
      .addBooleanOption((o) => o.setName("anonymous").setDescription("Hide who voted (default: false)"))
  )
  .addSubcommand((sub) =>
    sub
      .setName("close")
      .setDescription("Close a poll early")
      .addStringOption((o) => o.setName("message_id").setDescription("Poll message ID").setRequired(true))
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "create") {
    return handleCreatePoll(interaction);
  } else if (subcommand === "close") {
    return handleClosePoll(interaction);
  }
}

async function handleCreatePoll(interaction) {
  const question = interaction.options.getString("question");
  const durationStr = interaction.options.getString("duration");
  const isAnonymous = interaction.options.getBoolean("anonymous") || false;

  const options = [];
  for (let i = 1; i <= 4; i++) {
    const opt = interaction.options.getString(`option${i}`);
    if (opt) options.push(opt);
  }

  if (options.length < 2) {
    return interaction.reply({
      embeds: [errorEmbed("You need at least 2 options")],
      flags: 64,
    });
  }

  let endsAt = null;
  if (durationStr) {
    const duration = parseDuration(durationStr);
    if (!duration) {
      return interaction.reply({
        embeds: [errorEmbed("Invalid duration format. Use 1h, 30m, etc")],
        flags: 64,
      });
    }
    endsAt = Date.now() + duration;
  }

  // Build initial description
  const description = options.map((opt, i) => `${OPTION_EMOJIS[i]} **${OPTION_LABELS[i]}:** ${opt}\n> 0 votes`).join("\n\n");

  const embed = primaryEmbed("📊 Poll", question)
    .setDescription(description)
    .setFooter({ text: `${isAnonymous ? "Anonymous • " : ""}By ${interaction.user.username}` });

  if (endsAt) {
    embed.addFields({ name: "Closes", value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true });
  }

  // Build buttons
  const buttons = [];
  for (let i = 0; i < options.length; i++) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`poll_vote_${i}`)
        .setLabel(`${OPTION_LABELS[i]}: 0`)
        .setEmoji(OPTION_EMOJIS[i])
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const row = new ActionRowBuilder().addComponents(buttons);

  try {
    const msg = await interaction.reply({
      embeds: [embed],
      components: [row],
      fetchReply: true,
    });

    // Track poll
    activePolls.set(msg.id, {
      question,
      options,
      votes: new Map(),
      endsAt,
      anonymous: isAnonymous,
      hostId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });

    log(`[Poll] Created in ${interaction.guild.name}: "${question}"`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed(`Failed to create poll: ${error.message}`)],
      flags: 64,
    });
  }
}

function buildPollEmbed(poll, messageId) {
  const votes = new Map();
  for (let i = 0; i < poll.options.length; i++) {
    votes.set(i, 0);
  }

  for (const optionIndex of poll.votes.values()) {
    votes.set(optionIndex, (votes.get(optionIndex) || 0) + 1);
  }

  const totalVotes = poll.votes.size;

  let description = "";
  for (let i = 0; i < poll.options.length; i++) {
    const count = votes.get(i) || 0;
    const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : "0";
    const barLength = Math.round((count / Math.max(totalVotes, 1)) * 20);
    const bar = "█".repeat(barLength) + "░".repeat(20 - barLength);

    description += `${OPTION_EMOJIS[i]} **${OPTION_LABELS[i]}:** ${poll.options[i]}\n`;
    description += `> ${bar} ${count} vote${count !== 1 ? "s" : ""} (${percentage}%)`;

    if (i < poll.options.length - 1) description += "\n\n";
  }

  const embed = primaryEmbed("📊 Poll", poll.question)
    .setDescription(description)
    .setFooter({ text: `${poll.anonymous ? "Anonymous • " : ""}By <@${poll.hostId}>` });

  if (poll.endsAt) {
    embed.addFields({ name: "Closes", value: `<t:${Math.floor(poll.endsAt / 1000)}:R>`, inline: true });
  }

  return embed;
}

async function handleClosePoll(interaction) {
  const messageId = interaction.options.getString("message_id");
  const poll = activePolls.get(messageId);

  if (!poll) {
    return interaction.reply({
      embeds: [errorEmbed("Poll not found or already closed")],
      flags: 64,
    });
  }

  // Check if user is poll host or has ManageMessages permission
  const isHost = poll.hostId === interaction.user.id;
  const hasPermission = interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages);

  if (!isHost && !hasPermission) {
    return interaction.reply({
      embeds: [errorEmbed("Only the poll creator or admins can close this poll")],
      flags: 64,
    });
  }

  try {
    const channel = interaction.client.channels.cache.get(poll.channelId);
    if (!channel || !channel.isTextBased()) {
      activePolls.delete(messageId);
      return interaction.reply({
        embeds: [errorEmbed("Could not find the poll message")],
        flags: 64,
      });
    }

    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      const resultEmbed = buildPollResults(poll);
      await msg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});
    }

    activePolls.delete(messageId);
    await interaction.reply({
      embeds: [successEmbed("Poll closed successfully")],
      flags: 64,
    });
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed(`Failed to close poll: ${error.message}`)],
      flags: 64,
    });
  }
}

export async function handlePollButton(interaction) {
  const messageId = interaction.message.id;
  const poll = activePolls.get(messageId);

  if (!poll) {
    return interaction.reply({
      embeds: [errorEmbed("This poll is no longer active")],
      flags: 64,
    });
  }

  const customId = interaction.customId;
  if (!customId.startsWith("poll_vote_")) {
    return;
  }

  const optionIndex = parseInt(customId.split("_")[2]);
  if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
    return interaction.reply({
      embeds: [errorEmbed("Invalid option")],
      flags: 64,
    });
  }

  // Update vote (toggle if same option clicked)
  const previousVote = poll.votes.get(interaction.user.id);

  let voteText;
  if (previousVote === optionIndex) {
    // Remove vote if clicking same option
    poll.votes.delete(interaction.user.id);
    voteText = "removed your vote";
  } else if (previousVote === undefined) {
    poll.votes.set(interaction.user.id, optionIndex);
    voteText = "voted";
  } else {
    poll.votes.set(interaction.user.id, optionIndex);
    voteText = "changed your vote";
  }

  await interaction.reply({
    content: `${voteText} for **${OPTION_LABELS[optionIndex]}**`,
    flags: 64,
  });

  // Update embed
  const newEmbed = buildPollEmbed(poll, messageId);

  // Rebuild buttons with updated counts
  const votes = new Map();
  for (let i = 0; i < poll.options.length; i++) {
    votes.set(i, 0);
  }
  for (const voteIndex of poll.votes.values()) {
    votes.set(voteIndex, (votes.get(voteIndex) || 0) + 1);
  }

  const buttons = [];
  for (let i = 0; i < poll.options.length; i++) {
    const count = votes.get(i) || 0;
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`poll_vote_${i}`)
        .setLabel(`${OPTION_LABELS[i]}: ${count}`)
        .setEmoji(OPTION_EMOJIS[i])
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const row = new ActionRowBuilder().addComponents(buttons);

  await interaction.message.edit({
    embeds: [newEmbed],
    components: [row],
  }).catch(() => {});
}

function buildPollResults(poll) {
  const votes = new Map();
  for (let i = 0; i < poll.options.length; i++) {
    votes.set(i, 0);
  }

  for (const optionIndex of poll.votes.values()) {
    votes.set(optionIndex, (votes.get(optionIndex) || 0) + 1);
  }

  const totalVotes = poll.votes.size;

  // Find max vote count for highlighting winner
  let maxVotes = 0;
  for (const count of votes.values()) {
    if (count > maxVotes) maxVotes = count;
  }

  let description = "";
  for (let i = 0; i < poll.options.length; i++) {
    const count = votes.get(i) || 0;
    const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : "0";
    const barLength = Math.round((count / Math.max(totalVotes, 1)) * 20);
    const bar = "█".repeat(barLength) + "░".repeat(20 - barLength);
    const isWinner = count === maxVotes && count > 0 ? "👑 " : "";

    description += `${isWinner}${OPTION_EMOJIS[i]} **${OPTION_LABELS[i]}:** ${poll.options[i]}\n`;
    description += `> ${bar} ${count} vote${count !== 1 ? "s" : ""} (${percentage}%)\n\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x10B981)
    .setTitle("✅ Poll Closed")
    .setDescription(poll.question)
    .addFields({ name: "Results", value: description, inline: false })
    .setFooter({ text: `${totalVotes} people voted` });

  return embed;
}

export function initPollData(loaded) {
  activePolls.clear();
  if (loaded && Array.isArray(loaded)) {
    for (const data of loaded) {
      const votes = new Map();
      if (data.votes && Array.isArray(data.votes)) {
        for (const [userId, optionIndex] of data.votes) {
          votes.set(userId, optionIndex);
        }
      }

      activePolls.set(data.messageId, {
        question: data.question,
        options: data.options,
        votes,
        endsAt: data.endsAt,
        anonymous: data.anonymous,
        hostId: data.hostId,
        guildId: data.guildId,
        channelId: data.channelId,
      });
    }
  }
}

export function getPollData() {
  const data = [];
  for (const [messageId, poll] of activePolls.entries()) {
    const votes = Array.from(poll.votes.entries());
    data.push({
      messageId,
      question: poll.question,
      options: poll.options,
      votes,
      endsAt: poll.endsAt,
      anonymous: poll.anonymous,
      hostId: poll.hostId,
      guildId: poll.guildId,
      channelId: poll.channelId,
    });
  }
  return data;
}

export function startPollTimers(client) {
  if (checkPollsInterval) clearInterval(checkPollsInterval);

  checkPollsInterval = setInterval(async () => {
    const now = Date.now();

    for (const [messageId, poll] of activePolls.entries()) {
      if (poll.endsAt && now >= poll.endsAt) {
        try {
          // Get channel directly using channelId
          const channel = client.channels.cache.get(poll.channelId);
          if (!channel || !channel.isTextBased()) {
            activePolls.delete(messageId);
            continue;
          }

          // Fetch the message from the correct channel
          const msg = await channel.messages.fetch(messageId).catch(() => null);

          if (msg) {
            const resultEmbed = buildPollResults(poll);
            await msg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});
          }

          activePolls.delete(messageId);
        } catch (error) {
          activePolls.delete(messageId);
        }
      }
    }
  }, 30000); // Check every 30 seconds
}
