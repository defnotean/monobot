// @ts-check

import { ChannelType } from "discord.js";

/**
 * @param {{ type?: number } | null | undefined} channel
 */
export function isGuildCategory(channel) {
  return channel?.type === ChannelType.GuildCategory;
}

/**
 * @param {{ type?: number } | number | null | undefined} channelOrType
 */
export function channelTypeLabel(channelOrType) {
  const type = typeof channelOrType === "number" ? channelOrType : channelOrType?.type;
  switch (type) {
    case ChannelType.GuildVoice:
      return "voice channel";
    case ChannelType.GuildStageVoice:
      return "stage channel";
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildForum:
      return "forum channel";
    case ChannelType.GuildAnnouncement:
      return "announcement channel";
    default:
      return "text channel";
  }
}
