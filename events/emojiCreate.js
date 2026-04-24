import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "emojiCreate";

export async function execute(emoji) {
  let actor = null;
  let reason = null;
  try {
    const audit = await emoji.guild.fetchAuditLogs({ type: 60, limit: 1 }); // EMOJI_CREATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === emoji.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const emojiPreview = emoji.animated
    ? `<a:${emoji.name}:${emoji.id}>`
    : `<:${emoji.name}:${emoji.id}>`;

  await sendModLog(emoji.guild, logEvent({
    kind: "audit",
    title: "Emoji Added",
    actor,
    reason: reason || undefined,
    description: `${emojiPreview}  \`:${emoji.name}:\` was added${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`:${emoji.name}:\``,
      "Shortcut": emojiPreview,
      "Animated": emoji.animated ? "✅ yes" : "❌ no",
      "Managed": emoji.managed ? "yes (integration)" : null,
      "Direct Link": `[open full size](${emoji.url})`,
    },
    // Big image so admins can actually see the emoji clearly.
    image: emoji.url,
    // Green for add
    color: 0x57f287,
    footerNote: `Emoji ID: ${emoji.id}`,
  }));
}
