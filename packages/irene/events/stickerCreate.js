import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "stickerCreate";

// Discord sticker formats (StickerFormatType)
const FORMAT_NAMES = {
  1: "PNG",
  2: "APNG (animated)",
  3: "Lottie",
  4: "GIF",
};

export async function execute(sticker) {
  if (!sticker.guild) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await sticker.guild.fetchAuditLogs({ type: 90, limit: 1 }); // STICKER_CREATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === sticker.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(sticker.guild, logEvent({
    kind: "audit",
    title: "Sticker Added",
    actor,
    reason: reason || undefined,
    description: `Sticker **${sticker.name}** was added${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`${sticker.name}\``,
      "Description": sticker.description || "*(none)*",
      "Related Emoji": sticker.tags || "*(none)*",
      "Format": FORMAT_NAMES[sticker.format] || `type ${sticker.format}`,
      "Direct Link": `[open full size](${sticker.url})`,
    },
    image: sticker.url,
    color: 0x57f287,
    footerNote: `Sticker ID: ${sticker.id}`,
  }));
}
