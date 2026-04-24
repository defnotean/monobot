import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "stickerUpdate";

const FORMAT_NAMES = { 1: "PNG", 2: "APNG (animated)", 3: "Lottie", 4: "GIF" };

export async function execute(oldSticker, newSticker) {
  if (!newSticker.guild) return;

  const changedKeys = [];
  const beforeLines = [];
  const afterLines = [];

  if (oldSticker.name !== newSticker.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`${oldSticker.name}\``);
    afterLines.push(`**Name** · \`${newSticker.name}\``);
  }
  if (oldSticker.description !== newSticker.description) {
    changedKeys.push("Description");
    beforeLines.push(`**Description** · ${oldSticker.description || "*(none)*"}`);
    afterLines.push(`**Description** · ${newSticker.description || "*(none)*"}`);
  }
  if (oldSticker.tags !== newSticker.tags) {
    changedKeys.push("Emoji Tag");
    beforeLines.push(`**Related Emoji** · ${oldSticker.tags || "*(none)*"}`);
    afterLines.push(`**Related Emoji** · ${newSticker.tags || "*(none)*"}`);
  }

  if (!changedKeys.length) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newSticker.guild.fetchAuditLogs({ type: 91, limit: 1 }); // STICKER_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newSticker.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(newSticker.guild, logEvent({
    kind: "audit",
    title: "Sticker Updated",
    actor,
    reason: reason || undefined,
    description: `Sticker **${newSticker.name}** was updated${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.`,
    meta: {
      "Format": FORMAT_NAMES[newSticker.format] || `type ${newSticker.format}`,
      "Direct Link": `[open full size](${newSticker.url})`,
    },
    fields: [
      { name: "📋 Before", value: beforeLines.join("\n") || "*(unchanged)*", inline: true },
      { name: "📝 After",  value: afterLines.join("\n")  || "*(unchanged)*", inline: true },
    ],
    image: newSticker.url,
    color: 0x5865f2,
    footerNote: `Sticker ID: ${newSticker.id}`,
  }));
}
