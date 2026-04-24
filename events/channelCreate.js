import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { ChannelType } from "discord.js";

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
  [ChannelType.AnnouncementThread]: "Announcement Thread",
};

export const name = "channelCreate";

export async function execute(channel) {
  if (!channel.guild) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await channel.guild.fetchAuditLogs({ type: 10, limit: 1 }); // CHANNEL_CREATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === channel.id && Date.now() - entry.createdTimestamp < 5000) {
      if (entry.executor?.id === channel.guild.client.user.id) return; // bot-created, skip
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const channelType = CHANNEL_TYPE_NAMES[channel.type] ?? `type ${channel.type}`;
  const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;

  const meta = {
    "Name": `<#${channel.id}> · \`${channel.name}\``,
    "Type": channelType,
    "Category": channel.parent ? `\`${channel.parent.name}\` (\`${channel.parent.id}\`)` : "*(none)*",
    "Position": String(channel.rawPosition ?? channel.position ?? "?"),
    "NSFW": channel.nsfw ? "yes" : null,
    "Slowmode": channel.rateLimitPerUser ? `${channel.rateLimitPerUser}s` : null,
    "User Limit": isVoice && channel.userLimit ? String(channel.userLimit) : null,
    "Bitrate": isVoice && channel.bitrate ? `${Math.round(channel.bitrate / 1000)}kbps` : null,
    "Topic": channel.topic ? channel.topic.slice(0, 200) : null,
  };

  await sendModLog(channel.guild, logEvent({
    kind: "channelCreate",
    actor,
    reason: reason || undefined,
    description: `${channelType} channel <#${channel.id}> was created${actor ? ` by <@${actor.id}>` : ""}.`,
    meta,
    footerNote: `Channel ID: ${channel.id}`,
  }));
}
