import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "emojiDelete";

export async function execute(emoji) {
  let actor = null;
  let reason = null;
  try {
    const audit = await emoji.guild.fetchAuditLogs({ type: 62, limit: 1 }); // EMOJI_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === emoji.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const age = emoji.createdTimestamp
    ? Math.floor((Date.now() - emoji.createdTimestamp) / 86_400_000)
    : null;

  // Emoji URL still resolves even after deletion, so we keep showing it
  // as the image — admins can see EXACTLY what got removed.
  await sendModLog(emoji.guild, logEvent({
    kind: "audit",
    title: "Emoji Removed",
    actor,
    reason: reason || undefined,
    description: `\`:${emoji.name}:\` was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`:${emoji.name}:\``,
      "Animated": emoji.animated ? "yes" : "no",
      "Created": emoji.createdTimestamp ? `<t:${Math.floor(emoji.createdTimestamp / 1000)}:R>` : null,
      "Age": age !== null ? `${age}d` : null,
      "Direct Link": `[open full size](${emoji.url})`,
    },
    image: emoji.url,
    color: 0xed4245, // red for delete
    footerNote: `Emoji ID: ${emoji.id}`,
  }));
}
