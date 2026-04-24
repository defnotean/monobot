import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { successEmbed, errorEmbed, primaryEmbed } from "../../utils/embeds.js";
import { requirePermission } from "../../utils/permissions.js";
import { log } from "../../utils/logger.js";
import { saveGiveawayDb } from "../../database.js";

// ─── Active giveaways Map ────────────────────────────────────────────────────
// messageId → { channelId, guildId, prize, hostId, endsAt, winnerCount, entries: Set }
const activeGiveaways = new Map();
let checkGiveawaysInterval = null;

// Persist active giveaways to database after any mutation
function _persistGiveaways() {
  saveGiveawayDb(getGiveawayData());
}

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
  .setName("giveaway")
  .setDescription("Manage giveaways")
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Start a new giveaway")
      .addStringOption((o) => o.setName("prize").setDescription("Prize description").setRequired(true))
      .addStringOption((o) =>
        o.setName("duration").setDescription("Duration (e.g., 1h, 30m, 1d)").setRequired(true)
      )
      .addIntegerOption((o) => o.setName("winners").setDescription("Number of winners (default: 1)").setMinValue(1).setMaxValue(10))
      .addChannelOption((o) => o.setName("channel").setDescription("Channel to post in (default: current)"))
  )
  .addSubcommand((sub) =>
    sub
      .setName("end")
      .setDescription("End a giveaway early")
      .addStringOption((o) => o.setName("message_id").setDescription("Giveaway message ID").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("reroll")
      .setDescription("Pick new winners for a giveaway")
      .addStringOption((o) => o.setName("message_id").setDescription("Giveaway message ID").setRequired(true))
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

export async function execute(interaction) {
  if (!requirePermission(interaction, PermissionFlagsBits.ManageMessages, "Manage Messages")) return;

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "start") {
    await handleStart(interaction);
  } else if (subcommand === "end") {
    await handleEnd(interaction);
  } else if (subcommand === "reroll") {
    await handleReroll(interaction);
  }
}

async function handleStart(interaction) {
  const prize = interaction.options.getString("prize");
  const durationStr = interaction.options.getString("duration");
  const winnerCount = interaction.options.getInteger("winners") || 1;
  const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

  const duration = parseDuration(durationStr);
  if (!duration) {
    return interaction.reply({
      embeds: [errorEmbed("invalid duration", "use formats like 1h, 30m, 1d, or 2d12h")],
      flags: 64,
    });
  }

  const endsAt = Date.now() + duration;
  const startedAt = Date.now();

  // Create embed
  const embed = primaryEmbed("🎉 Giveaway", null)
    .setDescription(`**Prize:** ${prize}`)
    .addFields(
      { name: "Ends", value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
      { name: "Host", value: interaction.user.toString(), inline: true },
      { name: "Winners", value: winnerCount.toString(), inline: true },
      { name: "Entries", value: "0", inline: false }
    );

  // Create button
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter")
      .setLabel("0 Participants")
      .setEmoji("🎉")
      .setStyle(ButtonStyle.Primary)
  );

  // Resolve ping roles from guild settings
  const { getGiveawayPingRoles } = await import("../../database.js");
  const pingRoleIds = getGiveawayPingRoles(interaction.guildId);
  const pingContent = pingRoleIds.length ? pingRoleIds.map((id) => `<@&${id}>`).join(" ") : undefined;

  try {
    const msg = await targetChannel.send({ content: pingContent, embeds: [embed], components: [row] });

    // Track giveaway
    activeGiveaways.set(msg.id, {
      channelId: targetChannel.id,
      guildId: interaction.guildId,
      prize,
      hostId: interaction.user.id,
      endsAt,
      startedAt,
      winnerCount,
      entries: new Set(),
    });

    await interaction.reply({
      embeds: [successEmbed("giveaway started", `giveaway posted in ${targetChannel}`)],
      flags: 64,
    });

    _persistGiveaways();
    log(`[Giveaway] Started in ${interaction.guild.name}: ${prize} (${winnerCount} winner${winnerCount !== 1 ? "s" : ""})`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed("failed to create giveaway", error.message)],
      flags: 64,
    });
  }
}

async function handleEnd(interaction) {
  const messageId = interaction.options.getString("message_id");
  const giveaway = activeGiveaways.get(messageId);

  if (!giveaway) {
    return interaction.reply({
      embeds: [errorEmbed("giveaway not found", "make sure the message id is correct")],
      flags: 64,
    });
  }

  try {
    const channel = interaction.guild.channels.cache.get(giveaway.channelId);
    const msg = await channel.messages.fetch(messageId);

    const winners = pickWinners(giveaway.entries, giveaway.winnerCount);
    const winnerText = winners.length > 0 ? winners.map((id) => `<@${id}>`).join(", ") : "No entries";

    const resultEmbed = new EmbedBuilder()
      .setColor(0x10B981)
      .setTitle("🎉 Giveaway Ended")
      .setDescription(giveaway.prize)
      .addFields(
        { name: "Winners", value: winnerText, inline: false },
        { name: "Total Entries", value: giveaway.entries.size.toString(), inline: true },
        { name: "Started", value: `<t:${Math.floor(giveaway.startedAt / 1000)}:R>`, inline: true }
      );

    await msg.edit({ embeds: [resultEmbed], components: [] });

    // Send congratulations message
    if (winners.length > 0) {
      const congratsEmbed = new EmbedBuilder()
        .setColor(0x10B981)
        .setTitle("🎉 Congratulations!")
        .setDescription(`${winners.map((id) => `<@${id}>`).join(", ")} won **${giveaway.prize}**!`)
        .setTimestamp();

      await channel.send({ embeds: [congratsEmbed] }).catch(() => {});
    }

    activeGiveaways.delete(messageId);

    await interaction.reply({
      embeds: [successEmbed("giveaway ended", `winner${winners.length !== 1 ? "s" : ""}: ${winnerText}`)],
      flags: 64,
    });

    log(`[Giveaway] Ended in ${interaction.guild.name}: ${giveaway.prize}`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed("failed to end giveaway", error.message)],
      flags: 64,
    });
  }
}

async function handleReroll(interaction) {
  const messageId = interaction.options.getString("message_id");
  const giveaway = activeGiveaways.get(messageId);

  if (!giveaway) {
    return interaction.reply({
      embeds: [errorEmbed("giveaway not found", "make sure the message id is correct")],
      flags: 64,
    });
  }

  try {
    const channel = interaction.guild.channels.cache.get(giveaway.channelId);
    const msg = await channel.messages.fetch(messageId);

    const winners = pickWinners(giveaway.entries, giveaway.winnerCount);
    const winnerText = winners.length > 0 ? winners.map((id) => `<@${id}>`).join(", ") : "No entries";

    const resultEmbed = new EmbedBuilder()
      .setColor(0x10B981)
      .setTitle("🎉 Giveaway Rerolled")
      .setDescription(giveaway.prize)
      .addFields(
        { name: "Winners", value: winnerText, inline: false },
        { name: "Total Entries", value: giveaway.entries.size.toString(), inline: true },
        { name: "Started", value: `<t:${Math.floor(giveaway.startedAt / 1000)}:R>`, inline: true }
      );

    await msg.edit({ embeds: [resultEmbed], components: [] });

    await interaction.reply({
      embeds: [successEmbed("winners rerolled", `new winner${winners.length !== 1 ? "s" : ""}: ${winnerText}`)],
      flags: 64,
    });

    log(`[Giveaway] Rerolled in ${interaction.guild.name}: ${giveaway.prize}`);
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed("failed to reroll", error.message)],
      flags: 64,
    });
  }
}

function pickWinners(entries, count) {
  const entryArray = Array.from(entries);
  const winners = [];
  const selected = new Set();

  while (winners.length < count && winners.length < entryArray.length) {
    const randomIndex = Math.floor(Math.random() * entryArray.length);
    const userId = entryArray[randomIndex];
    if (!selected.has(userId)) {
      winners.push(userId);
      selected.add(userId);
    }
  }

  return winners;
}

export async function handleGiveawayButton(interaction) {
  const messageId = interaction.message.id;
  const giveaway = activeGiveaways.get(messageId);

  if (!giveaway) {
    return interaction.reply({
      embeds: [errorEmbed("Giveaway Expired", "This giveaway is no longer active")],
      flags: 64,
    });
  }

  const isEntering = !giveaway.entries.has(interaction.user.id);

  if (isEntering) {
    giveaway.entries.add(interaction.user.id);
    await interaction.reply({
      embeds: [successEmbed("Entered!", "You've been entered into the giveaway!")],
      flags: 64,
    });
  } else {
    giveaway.entries.delete(interaction.user.id);
    await interaction.reply({
      embeds: [primaryEmbed("Removed", "You've been removed from the giveaway")],
      flags: 64,
    });
  }

  // Update embed with entry count and button label with participants
  const embed = interaction.message.embeds[0];
  const newEmbed = EmbedBuilder.from(embed).setFields(
    { name: "Ends", value: `<t:${Math.floor(giveaway.endsAt / 1000)}:R>`, inline: true },
    { name: "Host", value: `<@${giveaway.hostId}>`, inline: true },
    { name: "Winners", value: giveaway.winnerCount.toString(), inline: true },
    { name: "Entries", value: giveaway.entries.size.toString(), inline: false }
  );

  // Update button with participant count
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter")
      .setLabel(`${giveaway.entries.size} Participant${giveaway.entries.size !== 1 ? "s" : ""}`)
      .setEmoji("🎉")
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.message.edit({ embeds: [newEmbed], components: [row] }).catch(() => {});
  _persistGiveaways();
}

export function initGiveawayData(loaded) {
  activeGiveaways.clear();
  if (loaded && Array.isArray(loaded)) {
    for (const data of loaded) {
      const entries = new Set(data.entries || []);
      activeGiveaways.set(data.messageId, {
        channelId: data.channelId,
        guildId: data.guildId,
        prize: data.prize,
        hostId: data.hostId,
        endsAt: data.endsAt,
        startedAt: data.startedAt || data.endsAt,
        winnerCount: data.winnerCount,
        entries,
      });
    }
  }
}

export function getGiveawayData() {
  const data = [];
  for (const [messageId, giveaway] of activeGiveaways.entries()) {
    data.push({
      messageId,
      channelId: giveaway.channelId,
      guildId: giveaway.guildId,
      prize: giveaway.prize,
      hostId: giveaway.hostId,
      endsAt: giveaway.endsAt,
      startedAt: giveaway.startedAt,
      winnerCount: giveaway.winnerCount,
      entries: Array.from(giveaway.entries),
    });
  }
  return data;
}

// Re-entry guard — a slow tick (network fetch + edit + send on several
// giveaways) can easily cross the 30s interval. Without this, tick N+1 fires
// while tick N is mid-loop, concurrently mutating activeGiveaways (double
// .delete() on the same messageId is fine, but double winner-announce is
// not — users would see the winners message twice).
let _finalizingGiveaways = false;

// Per-giveaway guard prevents the SAME giveaway from being processed twice
// even if somehow two different ticks both enter the loop concurrently (e.g.
// if the outer `_finalizingGiveaways` flag is ever bypassed).
const _finalizingSet = new Set();

export function startGiveawayTimers(client) {
  if (checkGiveawaysInterval) clearInterval(checkGiveawaysInterval);

  checkGiveawaysInterval = setInterval(async () => {
    if (_finalizingGiveaways) return; // skip this tick — previous still running
    _finalizingGiveaways = true;
    try {
      const now = Date.now();

      for (const [messageId, giveaway] of activeGiveaways.entries()) {
        if (now < giveaway.endsAt) continue;
        if (_finalizingSet.has(messageId)) continue;
        _finalizingSet.add(messageId);

        try {
          const channel = client.channels.cache.get(giveaway.channelId);
          if (!channel) {
            activeGiveaways.delete(messageId);
            continue;
          }

          const msg = await channel.messages.fetch(messageId).catch(() => null);
          if (!msg) {
            activeGiveaways.delete(messageId);
            continue;
          }

          const winners = pickWinners(giveaway.entries, giveaway.winnerCount);
          const winnerText = winners.length > 0 ? winners.map((id) => `<@${id}>`).join(", ") : "No entries";

          const resultEmbed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle("🎉 Giveaway Ended")
            .setDescription(giveaway.prize)
            .addFields(
              { name: "Winners", value: winnerText, inline: false },
              { name: "Total Entries", value: giveaway.entries.size.toString(), inline: true },
              { name: "Started", value: `<t:${Math.floor(giveaway.startedAt / 1000)}:R>`, inline: true }
            );

          await msg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});

          // Send congratulations message
          if (winners.length > 0) {
            const congratsEmbed = new EmbedBuilder()
              .setColor(0x10B981)
              .setTitle("🎉 Congratulations!")
              .setDescription(`${winners.map((id) => `<@${id}>`).join(", ")} won **${giveaway.prize}**!`)
              .setTimestamp();

            await channel.send({ embeds: [congratsEmbed] }).catch(() => {});
          }

          activeGiveaways.delete(messageId);
        } catch (error) {
          activeGiveaways.delete(messageId);
        } finally {
          _finalizingSet.delete(messageId);
        }
      }
    } finally {
      _finalizingGiveaways = false;
    }
  }, 30000); // Check every 30 seconds
}
