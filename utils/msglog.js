// ─── Enhanced Message Logging ───────────────────────────────────────────────
// Every log surfaces the full breadcrumb trail: author, channel, timestamps,
// attachments (name + size + URL), embeds, stickers, replies, thread info,
// message flags, and a jump link when it still exists.

import { getGuildSettings } from "../database.js";
import { logEvent, formatMeta } from "./embeds.js";
import { log } from "./logger.js";

// ─── Internal helpers ───────────────────────────────────────────────────────

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function attachmentList(attachments) {
  if (!attachments || attachments.size === 0) return null;
  return [...attachments.values()].map((a) => {
    const size = a.size ? ` \`(${fmtBytes(a.size)})\`` : "";
    const dims = a.width && a.height ? ` \`${a.width}×${a.height}\`` : "";
    const type = a.contentType ? ` · \`${a.contentType}\`` : "";
    return `• [\`${a.name}\`](${a.url})${size}${dims}${type}`;
  }).join("\n");
}

function embedSummary(embeds) {
  if (!embeds || embeds.length === 0) return null;
  return embeds.map((e, i) => {
    const parts = [];
    if (e.type) parts.push(`\`${e.type}\``);
    if (e.title) parts.push(`"${e.title.slice(0, 50)}"`);
    if (e.url) parts.push(`([link](${e.url}))`);
    if (e.author?.name) parts.push(`by ${e.author.name}`);
    return `#${i + 1}: ${parts.join(" · ")}`;
  }).join("\n");
}

function stickerList(stickers) {
  if (!stickers || stickers.size === 0) return null;
  return [...stickers.values()].map((s) => `\`${s.name}\` (\`${s.id}\`)`).join(", ");
}

function flagList(flags) {
  if (!flags) return null;
  const active = flags.toArray ? flags.toArray() : [];
  return active.length ? active.map((f) => `\`${f}\``).join(" ") : null;
}

function channelField(message) {
  const ch = message.channel;
  if (!ch) return null;
  const parentNote = ch.parent ? ` (in \`${ch.parent.name}\`)` : "";
  const threadNote = ch.isThread?.() ? " · thread" : "";
  return `<#${ch.id}>${parentNote}${threadNote} · \`${ch.id}\``;
}

function replyRefLine(message) {
  const ref = message.reference;
  if (!ref?.messageId) return null;
  const url = `https://discord.com/channels/${ref.guildId ?? message.guild.id}/${ref.channelId ?? message.channel.id}/${ref.messageId}`;
  return `[jump](${url}) · \`${ref.messageId}\``;
}

// ─── Message Edit ───────────────────────────────────────────────────────────

export async function logMessageEdit(oldMessage, newMessage) {
  const settings = getGuildSettings(oldMessage.guild.id);
  if (!settings?.log_channel) return;

  const channel = oldMessage.guild.channels.cache.get(settings.log_channel);
  if (!channel || !channel.isTextBased()) return;

  const CAP = 1024;
  const oldContent = (oldMessage.content || "*(empty)*").slice(0, CAP);
  const newContent = (newMessage.content || "*(empty)*").slice(0, CAP);

  const jumpUrl = `https://discord.com/channels/${oldMessage.guild.id}/${oldMessage.channel.id}/${oldMessage.id}`;
  const createdTs = Math.floor(oldMessage.createdTimestamp / 1000);
  const editedAt = newMessage.editedTimestamp ? Math.floor(newMessage.editedTimestamp / 1000) : Math.floor(Date.now() / 1000);

  const meta = {
    "Author": `<@${oldMessage.author.id}> · \`${oldMessage.author.tag}\` · \`${oldMessage.author.id}\``,
    "Channel": channelField(oldMessage),
    "Message ID": `\`${oldMessage.id}\` · [jump](${jumpUrl})`,
    "Posted": `<t:${createdTs}:F> (<t:${createdTs}:R>)`,
    "Edited": `<t:${editedAt}:R>`,
    "Reply To": replyRefLine(oldMessage),
    "Attachments": attachmentList(oldMessage.attachments),
    "Stickers": stickerList(oldMessage.stickers),
    "Flags": flagList(oldMessage.flags),
  };

  try {
    await channel.send({
      embeds: [
        logEvent({
          kind: "edit",
          target: oldMessage.author,
          description: `<@${oldMessage.author.id}> edited a message in <#${oldMessage.channel.id}>.`,
          meta,
          fields: [
            { name: "📋 Before", value: oldContent || "*(empty)*", inline: true },
            { name: "📝 After",  value: newContent || "*(empty)*", inline: true },
          ],
        }),
      ],
    }).catch(() => {});
  } catch (error) {
    log(`[MsgLog] Failed to log edit: ${error.message}`);
  }
}

// ─── Message Delete ─────────────────────────────────────────────────────────

export async function logMessageDelete(message) {
  const settings = getGuildSettings(message.guild.id);
  if (!settings?.log_channel) return;

  const channel = message.guild.channels.cache.get(settings.log_channel);
  if (!channel || !channel.isTextBased()) return;

  const MAX = 1024;
  let content = message.content || "";
  const truncated = content.length > MAX;
  content = content.slice(0, MAX) + (truncated ? "…(truncated)" : "");

  const createdTs = Math.floor(message.createdTimestamp / 1000);
  const ageMs = Date.now() - message.createdTimestamp;
  const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s`
               : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m`
               : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h`
               : `${Math.floor(ageMs / 86_400_000)}d`;

  // Try to find who deleted it (audit log)
  let deleter = null;
  try {
    const audit = await message.guild.fetchAuditLogs({ type: 72, limit: 3 }); // MESSAGE_DELETE
    const entry = audit.entries.find((e) =>
      e.target?.id === message.author?.id &&
      e.extra?.channel?.id === message.channel.id &&
      Date.now() - e.createdTimestamp < 5000
    );
    if (entry) deleter = entry.executor;
  } catch {}

  const meta = {
    "Author": message.author ? `<@${message.author.id}> · \`${message.author.tag}\` · \`${message.author.id}\`` : "*(unknown)*",
    "Channel": channelField(message),
    "Message ID": `\`${message.id}\``,
    "Posted": `<t:${createdTs}:F> (<t:${createdTs}:R>, existed for ${ageStr})`,
    "Deleted By": deleter ? `<@${deleter.id}> · \`${deleter.tag}\`` : "*(author or unknown)*",
    "Reply To": replyRefLine(message),
    "Flags": flagList(message.flags),
    "Pinned": message.pinned ? "yes" : null,
  };

  const extraFields = [];
  if (content) extraFields.push({ name: "Content", value: content, inline: false });
  const atts = attachmentList(message.attachments);
  if (atts) extraFields.push({ name: `Attachments (${message.attachments.size})`, value: atts.slice(0, 1024), inline: false });
  const embedsStr = embedSummary(message.embeds);
  if (embedsStr) extraFields.push({ name: `Embeds (${message.embeds.length})`, value: embedsStr.slice(0, 1024), inline: false });
  const stickersStr = stickerList(message.stickers);
  if (stickersStr) extraFields.push({ name: "Stickers", value: stickersStr, inline: false });

  // Find the first image attachment (if any) so admins can SEE the deleted image.
  // Discord keeps attachment CDN URLs live for a window after deletion.
  let previewImage = null;
  for (const att of message.attachments.values()) {
    const isImage = att.contentType?.startsWith("image/")
      || /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(att.name || att.url || "");
    if (isImage) { previewImage = att.url; break; }
  }
  // Sticker as fallback preview
  if (!previewImage && message.stickers?.size) {
    const firstSticker = message.stickers.first();
    if (firstSticker?.url) previewImage = firstSticker.url;
  }

  try {
    await channel.send({
      embeds: [
        logEvent({
          kind: "delete",
          target: message.author,
          actor: deleter,
          description: message.author
            ? `A message from <@${message.author.id}> was deleted in <#${message.channel.id}>.`
            : `A message was deleted in <#${message.channel.id}>.`,
          meta,
          fields: extraFields,
          image: previewImage,
        }),
      ],
    }).catch(() => {});
  } catch (error) {
    log(`[MsgLog] Failed to log delete: ${error.message}`);
  }
}

// ─── Ghost Ping ─────────────────────────────────────────────────────────────

export async function logGhostPing(message) {
  if (message.mentions.size === 0) return;
  const otherMentions = message.mentions.users?.filter((u) => u.id !== message.author.id) ?? message.mentions.filter((u) => u.id !== message.author.id);
  if (otherMentions.size === 0) return;

  const settings = getGuildSettings(message.guild.id);
  if (!settings?.log_channel) return;

  const channel = message.guild.channels.cache.get(settings.log_channel);
  if (!channel || !channel.isTextBased()) return;

  const mentionList = Array.from(otherMentions.values())
    .map((u) => `<@${u.id}> · \`${u.tag}\` · \`${u.id}\``)
    .join("\n") || "*(none)*";

  const roleMentions = message.mentions.roles?.size
    ? message.mentions.roles.map((r) => `<@&${r.id}> · \`${r.name}\``).join("\n")
    : null;

  const createdTs = Math.floor(message.createdTimestamp / 1000);
  const CAP = 1024;
  const content = (message.content || "*(no content)*").slice(0, CAP);

  const meta = {
    "Pinger": `<@${message.author.id}> · \`${message.author.tag}\` · \`${message.author.id}\``,
    "Channel": channelField(message),
    "Message ID": `\`${message.id}\``,
    "Posted": `<t:${createdTs}:F> (<t:${createdTs}:R>)`,
    "Users Pinged": `${otherMentions.size}`,
    "Roles Pinged": roleMentions ? `${message.mentions.roles.size}` : null,
    "@everyone/@here": message.mentions.everyone ? "yes ⚠️" : null,
  };

  const extraFields = [
    { name: "Content", value: content, inline: false },
    { name: "Pinged Users", value: mentionList.slice(0, 1024), inline: false },
  ];
  if (roleMentions) extraFields.push({ name: "Pinged Roles", value: roleMentions.slice(0, 1024), inline: false });

  try {
    await channel.send({
      embeds: [
        logEvent({
          kind: "ghostPing",
          target: message.author,
          description: `<@${message.author.id}> ghost-pinged ${otherMentions.size} user${otherMentions.size === 1 ? "" : "s"} in <#${message.channel.id}>.`,
          meta,
          fields: extraFields,
        }),
      ],
    }).catch(() => {});
  } catch (error) {
    log(`[MsgLog] Failed to log ghost ping: ${error.message}`);
  }
}

// ─── Bulk Delete ────────────────────────────────────────────────────────────

export async function logBulkDelete(messages, channel) {
  const settings = getGuildSettings(channel.guild.id);
  if (!settings?.log_channel) return;

  const logChannel = channel.guild.channels.cache.get(settings.log_channel);
  if (!logChannel || !logChannel.isTextBased()) return;

  try {
    const arr = Array.from(messages.values());
    const authors = new Map(); // userId -> { tag, count }
    let totalAttachments = 0;
    let totalEmbeds = 0;
    let earliest = Infinity;
    let latest = 0;

    for (const m of arr) {
      if (m.author?.id) {
        const a = authors.get(m.author.id) || { tag: m.author.tag, count: 0 };
        a.count++;
        authors.set(m.author.id, a);
      }
      totalAttachments += m.attachments?.size || 0;
      totalEmbeds += m.embeds?.length || 0;
      if (m.createdTimestamp) {
        earliest = Math.min(earliest, m.createdTimestamp);
        latest = Math.max(latest, m.createdTimestamp);
      }
    }

    const sample = arr.slice(0, 8).map((m) => {
      const body = (m.content || "*(no content)*").slice(0, 100);
      const attNote = m.attachments?.size ? ` 📎${m.attachments.size}` : "";
      const embedNote = m.embeds?.length ? ` 🖼${m.embeds.length}` : "";
      return `\`${m.id}\` **${m.author?.username ?? "?"}**${attNote}${embedNote} — ${body}`;
    }).join("\n");
    const sampleText = arr.length > 8 ? `${sample}\n… and ${arr.length - 8} more` : sample;

    const authorBreakdown = [...authors.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([id, a]) => `<@${id}> · \`${a.tag}\` × ${a.count}`)
      .join("\n");

    // Find who did it
    let deleter = null;
    try {
      const audit = await channel.guild.fetchAuditLogs({ type: 73, limit: 1 }); // MESSAGE_BULK_DELETE
      const entry = audit.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 10_000) deleter = entry.executor;
    } catch {}

    const meta = {
      "Channel": channelField({ channel }),
      "Messages Deleted": String(messages.size),
      "Unique Authors": String(authors.size),
      "Attachments Lost": totalAttachments > 0 ? String(totalAttachments) : null,
      "Embeds Lost": totalEmbeds > 0 ? String(totalEmbeds) : null,
      "Span": earliest !== Infinity ? `<t:${Math.floor(earliest / 1000)}:f> → <t:${Math.floor(latest / 1000)}:f>` : null,
      "Deleted By": deleter ? `<@${deleter.id}> · \`${deleter.tag}\`` : "*(unknown)*",
    };

    await logChannel.send({
      embeds: [
        logEvent({
          kind: "bulkDelete",
          actor: deleter,
          description: `\`${messages.size}\` messages deleted in <#${channel.id}>.`,
          meta,
          fields: [
            authorBreakdown ? { name: "Top Authors", value: authorBreakdown.slice(0, 1024), inline: false } : null,
            sampleText ? { name: `Sample (${Math.min(arr.length, 8)}/${arr.length})`, value: sampleText.slice(0, 1024), inline: false } : null,
          ].filter(Boolean),
        }),
      ],
    }).catch(() => {});
  } catch (error) {
    log(`[MsgLog] Failed to log bulk delete: ${error.message}`);
  }
}
