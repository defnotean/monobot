// ─── Server Stats Channels ────────────────────────────────────────────────────
// Updates voice channels with live member count stats.
// Rate-limited to only rename when the value has changed.

import { getStatsChannels } from "../database.js";
import { log } from "./logger.js";

// channelId → last displayed value (to skip unnecessary renames)
const lastValues = new Map();

export async function updateStatsChannels(guild) {
  const config = getStatsChannels(guild.id);
  if (!config) return;

  const { members_channel_id, online_channel_id, bots_channel_id } = config;

  // Use cached members — avoid fetching the entire member list on every update.
  // memberCount from guild object is always up-to-date for total count.
  const allMembers = guild.members.cache;
  const humans = allMembers.filter((m) => !m.user.bot);
  const bots = allMembers.filter((m) => m.user.bot);
  const online = humans.filter((m) => m.presence?.status && m.presence.status !== "offline");

  // For total member count use guild.memberCount (always accurate, no fetch needed)
  const totalCount = guild.memberCount - bots.size;
  const onlineCount = online.size;
  const botCount = bots.size;

  const updates = [
    { id: members_channel_id, name: `👥 Members: ${totalCount.toLocaleString()}`, value: totalCount },
    { id: online_channel_id, name: `🟢 Online: ${onlineCount.toLocaleString()}`, value: onlineCount },
    { id: bots_channel_id, name: `🤖 Bots: ${botCount.toLocaleString()}`, value: botCount },
  ];

  for (const { id, name, value } of updates) {
    if (!id) continue;
    if (lastValues.get(id) === value) continue; // no change, skip rename

    try {
      const channel = guild.channels.cache.get(id);
      if (!channel) continue;
      await channel.setName(name, "Stats update");
      lastValues.set(id, value);
    } catch (err) {
      log(`[Stats] Failed to update stats channel ${id}: ${err.message}`);
    }
  }
}
