import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

const STATUS = { 1: "Scheduled", 2: "Active", 3: "Completed", 4: "Cancelled" };

export const name = "guildScheduledEventUpdate";

export async function execute(oldEvent, newEvent) {
  if (!newEvent?.guild) return;

  const changedKeys = [];
  const beforeLines = [];
  const afterLines = [];

  if (oldEvent?.name !== newEvent.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`${oldEvent?.name ?? "?"}\``);
    afterLines.push(`**Name** · \`${newEvent.name}\``);
  }
  if (oldEvent?.description !== newEvent.description) {
    changedKeys.push("Description");
    beforeLines.push(`**Description** · ${oldEvent?.description ? oldEvent.description.slice(0, 100) : "*(none)*"}`);
    afterLines.push(`**Description** · ${newEvent.description ? newEvent.description.slice(0, 100) : "*(none)*"}`);
  }
  if (oldEvent?.status !== newEvent.status) {
    changedKeys.push("Status");
    beforeLines.push(`**Status** · ${STATUS[oldEvent?.status] ?? oldEvent?.status}`);
    afterLines.push(`**Status** · ${STATUS[newEvent.status] ?? newEvent.status}`);
  }
  if (oldEvent?.scheduledStartTimestamp !== newEvent.scheduledStartTimestamp) {
    changedKeys.push("Start Time");
    beforeLines.push(`**Start** · ${oldEvent?.scheduledStartTimestamp ? `<t:${Math.floor(oldEvent.scheduledStartTimestamp / 1000)}:F>` : "*(unset)*"}`);
    afterLines.push(`**Start** · ${newEvent.scheduledStartTimestamp ? `<t:${Math.floor(newEvent.scheduledStartTimestamp / 1000)}:F>` : "*(unset)*"}`);
  }
  if (oldEvent?.channelId !== newEvent.channelId) {
    changedKeys.push("Channel");
    beforeLines.push(`**Channel** · ${oldEvent?.channelId ? `<#${oldEvent.channelId}>` : "*(none)*"}`);
    afterLines.push(`**Channel** · ${newEvent.channelId ? `<#${newEvent.channelId}>` : "*(none)*"}`);
  }

  if (!changedKeys.length) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newEvent.guild.fetchAuditLogs({ type: 101, limit: 1 }); // SCHEDULED_EVENT_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newEvent.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(newEvent.guild, logEvent({
    kind: "audit",
    title: "Event Updated",
    actor,
    reason: reason || undefined,
    description: `📅 **${newEvent.name}** was updated${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.`,
    meta: {
      "Name": `\`${newEvent.name}\``,
      "Status": STATUS[newEvent.status] ?? `status ${newEvent.status}`,
      "Subscribers": newEvent.userCount != null ? String(newEvent.userCount) : null,
    },
    fields: [
      { name: "📋 Before", value: beforeLines.join("\n") || "*(unchanged)*", inline: true },
      { name: "📝 After",  value: afterLines.join("\n")  || "*(unchanged)*", inline: true },
    ],
    color: 0x5865f2,
    footerNote: `Event ID: ${newEvent.id}`,
  }));
}
