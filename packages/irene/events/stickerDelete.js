import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "stickerDelete";

const FORMAT_NAMES = { 1: "PNG", 2: "APNG (animated)", 3: "Lottie", 4: "GIF" };

export async function execute(sticker) {
  if (!sticker.guild) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await sticker.guild.fetchAuditLogs({ type: 92, limit: 1 }); // STICKER_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === sticker.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const age = sticker.createdTimestamp
    ? Math.floor((Date.now() - sticker.createdTimestamp) / 86_400_000)
    : null;

  await sendModLog(sticker.guild, logEvent({
    kind: "audit",
    title: "Sticker Removed",
    actor,
    reason: reason || undefined,
    description: `Sticker **${sticker.name}** was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Name": `\`${sticker.name}\``,
      "Description": sticker.description || "*(none)*",
      "Format": FORMAT_NAMES[sticker.format] || `type ${sticker.format}`,
      "Created": sticker.createdTimestamp ? `<t:${Math.floor(sticker.createdTimestamp / 1000)}:R>` : null,
      "Age": age !== null ? `${age}d` : null,
      "Direct Link": `[open full size](${sticker.url})`,
    },
    image: sticker.url,
    color: 0xed4245,
    footerNote: `Sticker ID: ${sticker.id}`,
  }));
}
