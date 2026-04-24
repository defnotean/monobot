import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "emojiUpdate";

export async function execute(oldEmoji, newEmoji) {
  if (oldEmoji.name === newEmoji.name) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newEmoji.guild.fetchAuditLogs({ type: 61, limit: 1 }); // EMOJI_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newEmoji.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const preview = newEmoji.animated
    ? `<a:${newEmoji.name}:${newEmoji.id}>`
    : `<:${newEmoji.name}:${newEmoji.id}>`;

  await sendModLog(newEmoji.guild, logEvent({
    kind: "audit",
    title: "Emoji Renamed",
    actor,
    reason: reason || undefined,
    description: `${preview} emoji was renamed${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Before": `\`:${oldEmoji.name}:\``,
      "After": `\`:${newEmoji.name}:\``,
      "Animated": newEmoji.animated ? "yes" : "no",
      "Direct Link": `[open full size](${newEmoji.url})`,
    },
    image: newEmoji.url,
    color: 0x5865f2, // blurple for update
    footerNote: `Emoji ID: ${newEmoji.id}`,
  }));
}
