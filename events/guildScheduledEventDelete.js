import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "guildScheduledEventDelete";

export async function execute(event) {
  let actor = null;
  let reason = null;
  try {
    const audit = await event.guild.fetchAuditLogs({ type: 102, limit: 1 }); // SCHEDULED_EVENT_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === event.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(event.guild, logEvent({
    kind: "audit",
    title: "Event Cancelled",
    actor,
    reason: reason || undefined,
    description: `📅 **${event.name}** was cancelled${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`${event.name}\``,
      "Was Scheduled For": event.scheduledStartTimestamp
        ? `<t:${Math.floor(event.scheduledStartTimestamp / 1000)}:F> (<t:${Math.floor(event.scheduledStartTimestamp / 1000)}:R>)`
        : null,
      "Subscriber Count": event.userCount != null ? String(event.userCount) : null,
      "Cancelled By": actor
        ? `<@${actor.id}> · \`${actor.tag}\`${actor.bot ? " 🤖" : ""}`
        : "*(unknown)*",
    },
    color: 0xed4245,
    footerNote: `Event ID: ${event.id}`,
  }));
}
