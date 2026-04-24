import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "threadUpdate";

const autoArchiveMap = { 60: "1 hour", 1440: "24 hours", 4320: "3 days", 10080: "1 week" };

export async function execute(oldThread, newThread) {
  if (!newThread.guild) return;

  const changedKeys = [];
  const beforeLines = [];
  const afterLines = [];

  if (oldThread.name !== newThread.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`${oldThread.name}\``);
    afterLines.push(`**Name** · \`${newThread.name}\``);
  }
  if (oldThread.archived !== newThread.archived) {
    changedKeys.push(newThread.archived ? "Archived" : "Unarchived");
    beforeLines.push(`**Archived** · ${oldThread.archived ? "✅ yes" : "❌ no"}`);
    afterLines.push(`**Archived** · ${newThread.archived ? "✅ yes" : "❌ no"}`);
  }
  if (oldThread.locked !== newThread.locked) {
    changedKeys.push(newThread.locked ? "Locked" : "Unlocked");
    beforeLines.push(`**Locked** · ${oldThread.locked ? "🔒 yes" : "🔓 no"}`);
    afterLines.push(`**Locked** · ${newThread.locked ? "🔒 yes" : "🔓 no"}`);
  }
  if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
    changedKeys.push("Slowmode");
    beforeLines.push(`**Slowmode** · ${oldThread.rateLimitPerUser || 0}s`);
    afterLines.push(`**Slowmode** · ${newThread.rateLimitPerUser || 0}s`);
  }
  if (oldThread.autoArchiveDuration !== newThread.autoArchiveDuration) {
    changedKeys.push("Auto-Archive");
    beforeLines.push(`**Auto-Archive** · ${autoArchiveMap[oldThread.autoArchiveDuration] ?? oldThread.autoArchiveDuration}`);
    afterLines.push(`**Auto-Archive** · ${autoArchiveMap[newThread.autoArchiveDuration] ?? newThread.autoArchiveDuration}`);
  }

  if (!changedKeys.length) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newThread.guild.fetchAuditLogs({ type: 111, limit: 1 }); // THREAD_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newThread.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(newThread.guild, logEvent({
    kind: "audit",
    title: "Thread Updated",
    actor,
    reason: reason || undefined,
    description: `Thread <#${newThread.id}> was updated${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.`,
    meta: {
      "Thread": `<#${newThread.id}> · \`${newThread.name}\``,
      "Parent": newThread.parentId ? `<#${newThread.parentId}>` : null,
      "Owner": newThread.ownerId ? `<@${newThread.ownerId}>` : null,
    },
    fields: [
      { name: "📋 Before", value: beforeLines.join("\n"), inline: true },
      { name: "📝 After",  value: afterLines.join("\n"),  inline: true },
    ],
    color: 0x5865f2,
    footerNote: `Thread ID: ${newThread.id}`,
  }));
}
