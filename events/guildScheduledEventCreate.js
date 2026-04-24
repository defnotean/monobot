import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

const ENTITY_TYPES = { 1: "Stage", 2: "Voice", 3: "External" };
const PRIVACY = { 2: "Guild Only" };

export const name = "guildScheduledEventCreate";

export async function execute(event) {
  let actor = event.creator ?? null;
  try {
    if (!actor) {
      const audit = await event.guild.fetchAuditLogs({ type: 100, limit: 1 }); // SCHEDULED_EVENT_CREATE
      const entry = audit.entries.first();
      if (entry && entry.target?.id === event.id && Date.now() - entry.createdTimestamp < 5000) {
        actor = entry.executor;
      }
    }
  } catch {}

  const startTs = Math.floor(event.scheduledStartTimestamp / 1000);
  const endTs = event.scheduledEndTimestamp ? Math.floor(event.scheduledEndTimestamp / 1000) : null;

  await sendModLog(event.guild, logEvent({
    kind: "audit",
    title: "Event Scheduled",
    actor,
    description: `📅 **${event.name}** was scheduled${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`${event.name}\``,
      "Description": event.description ? event.description.slice(0, 200) : null,
      "Starts": `<t:${startTs}:F> (<t:${startTs}:R>)`,
      "Ends": endTs ? `<t:${endTs}:F>` : null,
      "Type": ENTITY_TYPES[event.entityType] ?? `type ${event.entityType}`,
      "Privacy": PRIVACY[event.privacyLevel] ?? `level ${event.privacyLevel}`,
      "Channel": event.channelId ? `<#${event.channelId}>` : null,
      "Location": event.entityMetadata?.location ? `📍 ${event.entityMetadata.location}` : null,
      "Creator": actor
        ? `<@${actor.id}> · \`${actor.tag}\`${actor.bot ? " 🤖" : ""}`
        : null,
    },
    image: event.coverImageURL?.({ size: 1024 }) ?? undefined,
    color: 0x57f287,
    footerNote: `Event ID: ${event.id}`,
  }));
}
