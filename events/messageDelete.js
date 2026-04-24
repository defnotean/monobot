import { AuditLogEvent } from "discord.js";
import { sendModLog } from "../utils/logger.js";
import { logEmbed, LC } from "../utils/embeds.js";
import { cacheDeletedMessage } from "../utils/snipe.js";

export const name = "messageDelete";

export async function execute(message) {
  if (message.partial) { try { await message.fetch(); } catch { return; } }
  if (!message.guild) return;

  // Cache for snipe (before bot check so we capture the message object)
  cacheDeletedMessage(message);

  // Skip bots
  if (message.author?.bot) return;

  const channelId = message.channelId ?? message.channel?.id;

  // ── Audit log lookup — gives us who deleted + whose message it was ──────────
  // Small delay: audit log entries take ~500ms to appear after the event fires.
  let deletedBy = null;
  let auditTarget = null;
  try {
    await new Promise((r) => setTimeout(r, 600));
    const logs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 });
    const entry = logs.entries.find(
      (e) =>
        e.extra?.channel?.id === channelId &&
        Date.now() - e.createdTimestamp < 8_000
    );
    if (entry) {
      deletedBy = entry.executor;
      auditTarget = entry.target; // the user whose message was deleted
    }
  } catch { /* audit log not available — continue without it */ }

  // ── Resolve author ───────────────────────────────────────────────────────────
  const author = (!message.partial && message.author) ? message.author : auditTarget ?? null;
  const content = (!message.partial && message.author)
    ? (message.content?.slice(0, 1800) || "*empty message*")
    : "*message was not in cache*";

  // Skip if the author was a bot (resolved from audit log)
  if (author?.bot) return;

  // ── Build embed ──────────────────────────────────────────────────────────────
  const embed = logEmbed("Message Deleted", LC.message);

  if (author) {
    embed
      .setAuthor({ name: author.tag ?? author.username ?? "Unknown User", iconURL: author.displayAvatarURL?.() })
      .setThumbnail(author.displayAvatarURL?.({ size: 256 }));
  }

  const fields = [];
  if (author) fields.push({ name: "Author", value: `<@${author.id}>`, inline: true });
  fields.push({ name: "Channel", value: `<#${channelId}>`, inline: true });
  if (deletedBy && deletedBy.id !== author?.id) {
    fields.push({ name: "Deleted By", value: `<@${deletedBy.id}>`, inline: true });
  }
  fields.push({ name: "Content", value: content });

  embed.addFields(fields).setFooter({ text: `Message ID: ${message.id}` });

  await sendModLog(message.guild, embed);
}
