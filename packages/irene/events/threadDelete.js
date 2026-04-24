import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "threadDelete";

export async function execute(thread) {
  if (!thread.guild) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await thread.guild.fetchAuditLogs({ type: 112, limit: 1 }); // THREAD_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === thread.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const age = thread.createdTimestamp
    ? Math.floor((Date.now() - thread.createdTimestamp) / 3_600_000)
    : null;

  await sendModLog(thread.guild, logEvent({
    kind: "audit",
    title: "Thread Deleted",
    actor,
    reason: reason || undefined,
    description: `Thread \`${thread.name}\` was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Thread": `\`${thread.name}\` · \`${thread.id}\``,
      "Parent": thread.parentId ? `<#${thread.parentId}>` : "*(unknown)*",
      "Created": thread.createdTimestamp ? `<t:${Math.floor(thread.createdTimestamp / 1000)}:R>` : null,
      "Age": age !== null ? (age < 24 ? `${age}h` : `${Math.floor(age / 24)}d`) : null,
      "Owner": thread.ownerId ? `<@${thread.ownerId}>` : null,
      "Message Count": thread.messageCount != null ? String(thread.messageCount) : null,
    },
    color: 0xed4245,
    footerNote: `Thread ID: ${thread.id}`,
  }));
}
