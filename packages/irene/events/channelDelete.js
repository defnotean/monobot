import { sendModLog, log } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { ChannelType } from "discord.js";
import { trackAction } from "../utils/antinuke.js";

const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: "Text",
  [ChannelType.GuildVoice]: "Voice",
  [ChannelType.GuildCategory]: "Category",
  [ChannelType.GuildAnnouncement]: "Announcement",
  [ChannelType.GuildStageVoice]: "Stage",
  [ChannelType.GuildForum]: "Forum",
  [ChannelType.GuildMedia]: "Media",
  [ChannelType.PublicThread]: "Public Thread",
  [ChannelType.PrivateThread]: "Private Thread",
};

export const name = "channelDelete";

export async function execute(channel) {
  if (!channel.guild) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await channel.guild.fetchAuditLogs({ type: 12, limit: 1 }); // CHANNEL_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === channel.id && Date.now() - entry.createdTimestamp < 5000) {
      if (entry.executor?.id === channel.guild.client.user.id) return; // bot-deleted, skip
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const channelType = CHANNEL_TYPE_NAMES[channel.type] ?? `type ${channel.type}`;
  const age = channel.createdTimestamp
    ? Math.floor((Date.now() - channel.createdTimestamp) / 86_400_000)
    : null;

  const meta = {
    "Name": `\`#${channel.name}\` · \`${channel.id}\``,
    "Type": channelType,
    "Category": channel.parent ? `\`${channel.parent.name}\`` : "*(none)*",
    "Created": channel.createdTimestamp ? `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>` : null,
    "Age": age !== null ? `${age} day${age === 1 ? "" : "s"}` : null,
    "Position": String(channel.rawPosition ?? channel.position ?? "?"),
    "Topic": channel.topic ? channel.topic.slice(0, 200) : null,
  };

  await sendModLog(channel.guild, logEvent({
    kind: "channelDelete",
    actor,
    reason: reason || undefined,
    description: `${channelType} channel \`#${channel.name}\` was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta,
    color: 0xED4245, // danger red
    footerNote: `Channel ID: ${channel.id}`,
  }));

  // Anti-nuke: track who deleted and check for nuke pattern
  if (actor && actor.id !== channel.guild.client.user.id) {
    try {
      trackAction(channel.guild.id, actor.id, "channel_delete", channel.guild).catch(() => {});
    } catch {}
  }
}
