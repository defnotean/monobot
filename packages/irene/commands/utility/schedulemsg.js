import { SlashCommandBuilder, ChannelType } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed } from "../../utils/embeds.js";
import { paginate } from "../../utils/pagination.js";
import { log } from "../../utils/logger.js";

const scheduledMessages = new Map(); // guildId → [{ id, channelId, message, nextRunAt, repeat, createdBy }]
let scheduleTimers = new Set();

// Parse relative time like "30m", "2h", "1d"
function parseRelativeTime(str) {
  const match = str.trim().match(/^(\d+)([mhd])$/i);
  if (!match) return null;
  const [, num, unit] = match;
  const ms = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit.toLowerCase()];
  return Date.now() + parseInt(num) * ms;
}

// Parse time like "8pm", "Friday 8pm"
function parseNamedTime(str) {
  const trimmed = str.trim().toLowerCase();

  // Try "8pm" format
  const timeMatch = trimmed.match(/^(\d{1,2})(am|pm)?$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const isPm = timeMatch[2] === "pm";
    const target = new Date();
    target.setHours(isPm ? (hour % 12) + 12 : hour % 12, 0, 0, 0);
    if (target < new Date()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  // Try "Friday 8pm" format
  const dayMatch = trimmed.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(am|pm)?$/);
  if (dayMatch) {
    const dayName = dayMatch[1];
    const hour = parseInt(dayMatch[2]);
    const isPm = dayMatch[3] === "pm";
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayIndex = days.indexOf(dayName);
    if (dayIndex === -1) return null;

    const target = new Date();
    const currentDay = target.getDay();
    let daysToAdd = dayIndex - currentDay;
    if (daysToAdd <= 0) daysToAdd += 7;

    target.setDate(target.getDate() + daysToAdd);
    target.setHours(isPm ? (hour % 12) + 12 : hour % 12, 0, 0, 0);
    return target.getTime();
  }

  return null;
}

export const data = new SlashCommandBuilder()
  .setName("schedulemsg")
  .setDescription("Schedule a message to be sent")
  .setDefaultMemberPermissions(0x4000000) // ManageMessages
  .addSubcommand((sub) =>
    sub
      .setName("send")
      .setDescription("Schedule a message")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Target channel")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText),
      )
      .addStringOption((opt) =>
        opt
          .setName("time")
          .setDescription("When (relative: 30m/2h/1d, or named: 8pm, Friday 8pm)")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription("Message content")
          .setRequired(true)
          .setMaxLength(2000),
      )
      .addStringOption((opt) =>
        opt
          .setName("repeat")
          .setDescription("Repeat interval")
          .addChoices({ name: "none", value: "none" }, { name: "daily", value: "daily" }, { name: "weekly", value: "weekly" }),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Show all scheduled messages"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel a scheduled message")
      .addIntegerOption((opt) =>
        opt.setName("id").setDescription("Message ID").setRequired(true),
      ),
  );

export async function execute(interaction) {
  // Check permission
  if (!interaction.memberPermissions?.has("ManageMessages")) {
    await interaction.reply({
      embeds: [errorEmbed("permission denied", "you need manage messages to use this")],
      flags: 64,
    }).catch(() => {});
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "send") {
    const channel = interaction.options.getChannel("channel");
    const timeStr = interaction.options.getString("time");
    const message = interaction.options.getString("message");
    const repeatStr = interaction.options.getString("repeat") ?? "none";

    // Validate message content length
    if (message.length > 2000) {
      await interaction.reply({
        embeds: [errorEmbed("Message Too Long", "message content must be max 2000 characters")],
        flags: 64,
      }).catch(() => {});
      return;
    }

    // Check if channel exists and is valid
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({
        embeds: [errorEmbed("Invalid Channel", "the target channel must be a text channel")],
        flags: 64,
      }).catch(() => {});
      return;
    }

    // Check if bot has Send Messages permission in the channel
    const permissions = channel.permissionsFor(interaction.client.user);
    if (!permissions?.has("SendMessages")) {
      await interaction.reply({
        embeds: [errorEmbed("Permission Denied", "bot cannot send messages in that channel")],
        flags: 64,
      }).catch(() => {});
      return;
    }

    let nextRun = parseRelativeTime(timeStr) || parseNamedTime(timeStr);
    if (!nextRun) {
      await interaction.reply({
        embeds: [errorEmbed("Invalid Time", "use relative (30m, 2h, 1d) or named (8pm, Friday 8pm)")],
        flags: 64,
      }).catch(() => {});
      return;
    }

    // Validate that time is in the future
    if (nextRun <= Date.now()) {
      await interaction.reply({
        embeds: [errorEmbed("Time in Past", "scheduled time must be in the future")],
        flags: 64,
      }).catch(() => {});
      return;
    }

    const guildId = interaction.guildId;
    const guildData = scheduledMessages.get(guildId) || [];
    const id = guildData.length > 0 ? Math.max(...guildData.map((m) => m.id)) + 1 : 1;

    const scheduled = {
      id,
      channelId: channel.id,
      message,
      nextRunAt: nextRun,
      repeat: repeatStr,
      createdBy: interaction.user.id,
    };

    guildData.push(scheduled);
    scheduledMessages.set(guildId, guildData);

    const runDate = new Date(nextRun).toLocaleString();
    await interaction.reply({
      embeds: [successEmbed("message scheduled", `ID: **${id}**\nChannel: ${channel}\nTime: ${runDate}\nRepeat: ${repeatStr}`)],
      flags: 64,
    }).catch(() => {});

    log(`[ScheduleMsg] ${interaction.user.tag} scheduled message #${id} in ${interaction.guild.name}`);
  } else if (subcommand === "list") {
    const guildId = interaction.guildId;
    const guildData = scheduledMessages.get(guildId) || [];

    if (guildData.length === 0) {
      await interaction.reply({
        embeds: [infoEmbed("No Scheduled Messages", "use `/schedulemsg send` to add one")],
        flags: 64,
      }).catch(() => {});
      return;
    }

    // Use pagination if there are many scheduled messages
    if (guildData.length > 5) {
      await paginate(interaction, {
        items: guildData,
        itemsPerPage: 5,
        formatPage: (items, pageNum, totalPages) => {
          const list = items
            .map((m) => {
              const channel = interaction.guild.channels.cache.get(m.channelId);
              const time = new Date(m.nextRunAt).toLocaleString();
              const channelName = channel?.name ?? "unknown";
              return `**#${m.id}** → #${channelName} at ${time} (${m.repeat})`;
            })
            .join("\n");
          return infoEmbed(`Scheduled Messages (Page ${pageNum}/${totalPages})`, list)
            .setFooter({ text: `${guildData.length} total messages` });
        },
        ephemeral: true,
        timeout: 120000,
      });
    } else {
      const list = guildData
        .map((m) => {
          const channel = interaction.guild.channels.cache.get(m.channelId);
          const time = new Date(m.nextRunAt).toLocaleString();
          const channelName = channel?.name ?? "unknown";
          return `**#${m.id}** → #${channelName} at ${time} (${m.repeat})`;
        })
        .join("\n");

      await interaction.reply({
        embeds: [infoEmbed("Scheduled Messages", list)
          .setFooter({ text: `${guildData.length} messages` })],
        flags: 64,
      }).catch(() => {});
    }
  } else if (subcommand === "cancel") {
    const id = interaction.options.getInteger("id");
    const guildId = interaction.guildId;
    const guildData = scheduledMessages.get(guildId) || [];

    const index = guildData.findIndex((m) => m.id === id);
    if (index === -1) {
      await interaction.reply({
        embeds: [errorEmbed("Not Found", `no scheduled message with id ${id}`)],
        flags: 64,
      }).catch(() => {});
      return;
    }

    guildData.splice(index, 1);
    scheduledMessages.set(guildId, guildData);

    await interaction.reply({
      embeds: [successEmbed("Cancelled", `scheduled message #${id} removed`)],
      flags: 64,
    }).catch(() => {});

    log(`[ScheduleMsg] ${interaction.user.tag} cancelled message #${id}`);
  }
}

export function initScheduleData(loaded) {
  if (loaded && typeof loaded === "object") {
    for (const [guildId, messages] of Object.entries(loaded)) {
      scheduledMessages.set(guildId, messages);
    }
  }
}

export function getScheduleData() {
  const data = {};
  for (const [guildId, messages] of scheduledMessages) {
    data[guildId] = messages;
  }
  return data;
}

export function startScheduleTimers(client) {
  // Clear old timers if any
  for (const timer of scheduleTimers) {
    clearInterval(timer);
  }
  scheduleTimers.clear();

  // Check every 30s
  const timer = setInterval(() => {
    const now = Date.now();

    for (const [guildId, messages] of scheduledMessages) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      for (const msg of messages) {
        if (msg.nextRunAt <= now && !msg._sending) {
          const channel = guild.channels.cache.get(msg.channelId);
          if (!channel) continue;

          // Mark as in-flight immediately to prevent double-fire on next 30s tick
          msg._sending = true;

          channel
            .send(msg.message)
            .then(() => {
              log(`[ScheduleMsg] sent scheduled message #${msg.id} in ${guild.name}`);

              // Handle repeat
              if (msg.repeat === "daily") {
                msg.nextRunAt = now + 24 * 60 * 60 * 1000;
                msg._sending = false;
              } else if (msg.repeat === "weekly") {
                msg.nextRunAt = now + 7 * 24 * 60 * 60 * 1000;
                msg._sending = false;
              } else {
                // Remove if no repeat
                const idx = messages.indexOf(msg);
                if (idx > -1) messages.splice(idx, 1);
              }
            })
            .catch((err) => {
              log(`[ScheduleMsg] error sending message #${msg.id}: ${err.message}`);
              msg._sending = false; // allow retry next tick
            });
        }
      }
    }
  }, 30 * 1000);

  scheduleTimers.add(timer);
  log("[ScheduleMsg] Timer started — checking every 30s");
}
