import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { ChannelType } from "discord.js";

const THREAD_TYPES = {
  [ChannelType.PublicThread]: "Public Thread",
  [ChannelType.PrivateThread]: "Private Thread",
  [ChannelType.AnnouncementThread]: "Announcement Thread",
};

export const name = "threadCreate";

export async function execute(thread, newlyCreated) {
  if (!newlyCreated || !thread.guild) return;

  // Thread owner is the user who created it (thread.ownerId is always set).
  // Fall back to audit log if owner fetch fails.
  let creator = null;
  try {
    if (thread.ownerId) {
      creator = await thread.guild.client.users.fetch(thread.ownerId).catch(() => null);
    }
    if (!creator) {
      const audit = await thread.guild.fetchAuditLogs({ type: 110, limit: 1 }); // THREAD_CREATE
      const entry = audit.entries.first();
      if (entry && entry.target?.id === thread.id && Date.now() - entry.createdTimestamp < 5000) {
        creator = entry.executor;
      }
    }
  } catch {}

  const threadType = THREAD_TYPES[thread.type] || `type ${thread.type}`;
  const autoArchiveMap = { 60: "1 hour", 1440: "24 hours", 4320: "3 days", 10080: "1 week" };

  await sendModLog(thread.guild, logEvent({
    kind: "audit",
    title: "Thread Created",
    actor: creator,
    description: `${threadType} <#${thread.id}> was created in <#${thread.parentId}>${creator ? ` by <@${creator.id}>` : ""}.`,
    meta: {
      "Thread": `<#${thread.id}> · \`${thread.name}\``,
      "Parent": `<#${thread.parentId}> · \`${thread.parent?.name ?? "?"}\``,
      "Type": threadType,
      "Auto-Archive": autoArchiveMap[thread.autoArchiveDuration] ?? `${thread.autoArchiveDuration}min`,
      "Slowmode": thread.rateLimitPerUser ? `${thread.rateLimitPerUser}s` : null,
      "Invitable": thread.invitable === false ? "no (private)" : null,
    },
    color: 0x5865f2, // blurple for thread
    footerNote: `Thread ID: ${thread.id}`,
  }));
}
