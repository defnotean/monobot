// ─── Shared Embed Builders ──────────────────────────────────────────────────

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// ─── Mod-action undo buttons ────────────────────────────────────────────────
// A small button row attached to mod-log embeds so admins can reverse an
// action with one click. CustomId format:
//   modundo:<kind>:<targetId>[:<extraParam>]
// Kinds: ban, timeout, mute, warn, warnsCleared
const _undoLabels = {
  ban:          { label: "Unban",          emoji: "🔓", style: ButtonStyle.Success },
  timeout:      { label: "Remove Timeout", emoji: "🔊", style: ButtonStyle.Success },
  mute:         { label: "Unmute",         emoji: "🔊", style: ButtonStyle.Success },
  warn:         { label: "Remove Warning", emoji: "✨", style: ButtonStyle.Secondary },
};

/**
 * Build an action row with a single "undo" button for a mod action.
 * `extra` is an optional field passed through the customId (e.g. the
 * warning ID for a warn-undo).
 */
export function buildUndoRow(kind, targetId, extra) {
  const cfg = _undoLabels[kind];
  if (!cfg || !targetId) return null;
  // Defense: reject obviously-bad target IDs so we don't build buttons the
  // handler will choke on. Warn kind allows numeric "target" (stored as id).
  if (kind !== "warn" && !/^\d{17,20}$/.test(String(targetId))) return null;
  const customId = extra != null
    ? `modundo:${kind}:${targetId}:${extra}`
    : `modundo:${kind}:${targetId}`;
  // Discord caps customId at 100 chars.
  if (customId.length > 100) return null;
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(cfg.label)
    .setEmoji(cfg.emoji)
    .setStyle(cfg.style);
  return new ActionRowBuilder().addComponents(button);
}

// ─── Brand icon (set on ready) ────────────────────────────────────────────────
let botIconURL = null;
export function setBotIcon(url) {
  botIconURL = url;
}
export function getBotIcon() {
  return botIconURL;
}

// ─── Icon map ─────────────────────────────────────────────────────────────────
const ICONS = {
  success: "✅", error: "❌", warning: "⚠️", info: "ℹ️",
  music: "🎵", playing: "▶️", paused: "⏸️", stopped: "⏹️", queue: "📋",
  mod: "🔨", ban: "🚫", kick: "👢", warn: "⚠️", mute: "🔇",
  voice: "🎙️", join: "📥", leave: "📤",
  star: "⭐", pin: "📌", edit: "✏️", delete: "🗑️",
  user: "👤", server: "🏠", role: "🎭", channel: "💬",
  shield: "🛡️", clock: "🕐", link: "🔗",
};

// ─── Base embed — adds brand footer ──────────────────────────────────────────
function base(color) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  if (botIconURL) e.setFooter({ text: "Irene", iconURL: botIconURL });
  else e.setFooter({ text: "Irene" });
  return e;
}

// ─── Exported embed builders ──────────────────────────────────────────────────

export function successEmbed(title, description) {
  return base(0x10B981).setTitle(`${ICONS.success}  ${title}`).setDescription(description ?? null);
}

export function errorEmbed(title, description) {
  return base(0xEF4444).setTitle(`${ICONS.error}  ${title}`).setDescription(description ?? null);
}

export function warnEmbed(title, description) {
  return base(0xF59E0B).setTitle(`${ICONS.warning}  ${title}`).setDescription(description ?? null);
}

export function infoEmbed(title, description) {
  return base(0x6366F1).setTitle(`${ICONS.info}  ${title}`).setDescription(description ?? null);
}

export function modEmbed(title, description) {
  return base(0xF97316).setTitle(`${ICONS.mod}  ${title}`).setDescription(description ?? null);
}

export function musicEmbed(title, description) {
  return base(0x1DB954).setTitle(`${ICONS.music}  ${title}`).setDescription(description ?? null);
}

export function primaryEmbed(title, description) {
  return base(0x7C3AED).setTitle(title).setDescription(description ?? null);
}

export function mutedEmbed(title, description) {
  return base(0x6B7280).setTitle(title).setDescription(description ?? null);
}

// ─── Log embed (legacy — still used by dozens of event files) ────────────────
export function logEmbed(title, color) {
  return new EmbedBuilder().setTitle(title).setColor(color).setTimestamp()
    .setFooter({ text: "Irene", ...(botIconURL ? { iconURL: botIconURL } : {}) });
}

// ─── Log embed colors ────────────────────────────────────────────────────────
export const LC = {
  join:    0x57f287,  // green
  leave:   0xed4245,  // red
  ban:     0x992d22,  // dark red
  unban:   0x57f287,  // green
  update:  0x5865f2,  // blurple
  voice:   0x0099e1,  // blue
  message: 0xfee75c,  // yellow
  channel: 0x9b59b6,  // purple
  role:    0xe67e22,  // orange
  audit:   0x95a5a6,  // gray
  danger:  0xed4245,  // red
};

// ═════════════════════════════════════════════════════════════════════════════
// NEW LOG EVENT BUILDER — use this for new event code. Produces a cleaner,
// more consistent layout than stacking .addFields() calls manually:
//
//   ┌─────────────────────────────────────┐
//   │ 🔨  Member Banned                   │ ← author bar with per-kind icon
//   │                                     │
//   │ @target was banned by @mod          │ ← natural-sentence description
//   │ Reason · raiding the server         │
//   │                                     │
//   │ User ID · 12345                     │ ← meta row (inline fields)
//   │ When    · <t:X:R>                   │
//   │                                     │
//   │                  [target avatar]    │ ← thumbnail for user events
//   │                                     │
//   │                    ID: 12345        │ ← footer
//   └─────────────────────────────────────┘
//
// Usage:
//   import { logEvent } from "../utils/embeds.js";
//   await sendModLog(guild, logEvent({
//     kind: "ban",
//     target: ban.user,
//     actor: moderator,                  // optional
//     reason: "raiding",                 // optional
//     description: "Custom description", // optional — overrides the auto one
//     fields: [                          // optional extras
//       { name: "Account Age", value: "2 years", inline: true },
//     ],
//   }));
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Per-event metadata: color, icon, and a short action verb we can weave
 * into an auto-generated description like "@user was banned by @mod".
 */
const LOG_KINDS = {
  // Mod actions
  ban:          { color: LC.ban,     icon: "🔨", verb: "was banned" },
  unban:        { color: LC.unban,   icon: "🔓", verb: "was unbanned" },
  kick:         { color: LC.ban,     icon: "👢", verb: "was kicked" },
  timeout:      { color: 0xF97316,   icon: "🔇", verb: "was timed out" },
  untimeout:    { color: LC.unban,   icon: "🔊", verb: "had their timeout lifted" },
  mute:         { color: 0xF97316,   icon: "🔇", verb: "was muted" },
  unmute:       { color: LC.unban,   icon: "🔊", verb: "was unmuted" },
  warn:         { color: 0xF59E0B,   icon: "⚠️",  verb: "was warned" },
  warnRemoved:  { color: LC.unban,   icon: "✨", verb: "had a warning removed" },
  warnsCleared: { color: LC.unban,   icon: "✨", verb: "had all warnings cleared" },

  // Membership
  join:         { color: LC.join,    icon: "📥", verb: "joined" },
  leave:        { color: LC.leave,   icon: "📤", verb: "left" },

  // Messages
  edit:         { color: LC.message, icon: "✏️",  verb: "edited a message" },
  delete:       { color: LC.message, icon: "🗑️",  verb: "had a message deleted" },
  bulkDelete:   { color: LC.message, icon: "🧹", verb: "bulk-deleted" },
  ghostPing:    { color: LC.message, icon: "👻", verb: "ghost-pinged" },
  pin:          { color: 0x0099e1,   icon: "📌", verb: "pinned a message" },
  unpin:        { color: 0x0099e1,   icon: "📌", verb: "unpinned a message" },

  // Server structure
  channelCreate:{ color: LC.channel, icon: "💬", verb: "created a channel" },
  channelDelete:{ color: LC.channel, icon: "💬", verb: "deleted a channel" },
  channelUpdate:{ color: LC.channel, icon: "💬", verb: "updated a channel" },
  roleCreate:   { color: LC.role,    icon: "🎭", verb: "created a role" },
  roleDelete:   { color: LC.role,    icon: "🎭", verb: "deleted a role" },
  roleUpdate:   { color: LC.role,    icon: "🎭", verb: "updated a role" },
  nickname:     { color: LC.update,  icon: "🏷️",  verb: "changed their nickname" },
  avatar:       { color: LC.update,  icon: "🖼️",  verb: "changed their avatar" },

  // Voice
  voiceJoin:    { color: LC.voice,   icon: "🎙️",  verb: "joined voice" },
  voiceLeave:   { color: LC.voice,   icon: "🎙️",  verb: "left voice" },
  voiceMove:    { color: LC.voice,   icon: "🎙️",  verb: "switched voice channels" },

  // Default / unknown
  audit:        { color: LC.audit,   icon: "📋", verb: "" },
};

/**
 * Normalize a user-ish input (Discord.js User, GuildMember, or a plain
 * { id, tag } object) into a consistent shape the embed builder can consume.
 */
function _normalizeUser(u) {
  if (!u) return null;
  const user = u.user ?? u; // accept GuildMember too
  if (!user.id) return null;
  const tag = user.tag
    || (user.username ? `${user.username}${user.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : ""}` : null)
    || user.globalName
    || user.id;
  const avatar = typeof user.displayAvatarURL === "function"
    ? user.displayAvatarURL({ size: 256 })
    : user.avatar || null;
  return { id: user.id, tag, avatar };
}

/**
 * Turn a plain k/v object into a compact Discord-flavored meta block:
 *   **Key** · value
 *   **Key** · value
 * Much cleaner than addFields() for short metadata.
 */
export function formatMeta(entries) {
  if (!entries) return "";
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `**${k}** · ${v}`)
    .join("\n");
}

/**
 * Build a log-channel embed for a specific kind of event. See the big comment
 * block above for usage.
 */
export function logEvent({
  kind,
  title,
  description,
  actor,
  target,
  reason,
  channel,
  meta,
  fields,
  thumbnail,
  image,
  url,
  footerNote,
  color: overrideColor,
  author: authorOverride,
}) {
  const cfg = LOG_KINDS[kind] || LOG_KINDS.audit;
  const color = overrideColor ?? cfg.color;
  const titleText = title || _titleFromKind(kind);

  const actorU  = _normalizeUser(actor);
  const targetU = _normalizeUser(target);

  const authorIcon = authorOverride?.iconURL
    ?? (targetU?.avatar)
    ?? botIconURL
    ?? undefined;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp()
    .setAuthor({
      // Discord author.name limit is 256 chars — clamp so oversized titles
      // don't crash the embed build and swallow the mod-log entry.
      name: `${cfg.icon}  ${String(titleText || "").slice(0, 240)}`,
      iconURL: authorIcon,
    });

  if (url) embed.setURL(url);

  // Description: either custom, or an auto-sentence like
  // "@target was banned by @actor." followed by the reason line.
  const parts = [];
  if (description) {
    parts.push(description);
  } else if (cfg.verb && (targetU || actorU)) {
    const who = targetU ? `<@${targetU.id}>` : "Someone";
    const by  = actorU && targetU && actorU.id !== targetU.id ? ` by <@${actorU.id}>` : "";
    parts.push(`${who} ${cfg.verb}${by}.`);
  }
  if (reason) parts.push(`**Reason** · ${reason}`);
  if (channel?.id) parts.push(`**Channel** · <#${channel.id}>`);

  if (meta) {
    const metaText = formatMeta(meta);
    if (metaText) parts.push(metaText);
  }
  if (parts.length) {
    // Discord description cap is 4096 — clamp so a giant meta dump (deleted
    // message content, long role list, etc) doesn't reject the whole embed.
    const joined = parts.join("\n");
    embed.setDescription(joined.length > 4090 ? joined.slice(0, 4090) + "…" : joined);
  }

  if (fields?.length) embed.addFields(fields.filter(Boolean));

  // Thumbnail: explicit > target avatar > (nothing)
  const thumb = thumbnail ?? targetU?.avatar ?? null;
  if (thumb) embed.setThumbnail(thumb);

  // Full-width image — used for emoji/sticker/avatar-change events where the
  // image IS the story.
  if (image) embed.setImage(image);

  // Footer: "ID: <targetOrActor> · Irene"
  const footerId = targetU?.id || actorU?.id;
  const footerText = [
    footerId ? `ID: ${footerId}` : null,
    footerNote,
    "Irene",
  ].filter(Boolean).join(" · ");
  embed.setFooter({ text: footerText, ...(botIconURL ? { iconURL: botIconURL } : {}) });

  return embed;
}

function _titleFromKind(kind) {
  if (!kind) return "Event";
  const map = {
    ban: "Member Banned",          unban: "Member Unbanned",
    kick: "Member Kicked",
    timeout: "Member Timed Out",   untimeout: "Timeout Removed",
    mute: "Member Muted",          unmute: "Member Unmuted",
    warn: "Member Warned",         warnRemoved: "Warning Removed", warnsCleared: "Warnings Cleared",
    join: "Member Joined",         leave: "Member Left",
    edit: "Message Edited",        delete: "Message Deleted",
    bulkDelete: "Bulk Delete",     ghostPing: "Ghost Ping",
    pin: "Message Pinned",         unpin: "Message Unpinned",
    channelCreate: "Channel Created", channelDelete: "Channel Deleted", channelUpdate: "Channel Updated",
    roleCreate: "Role Created",    roleDelete: "Role Deleted",     roleUpdate: "Role Updated",
    nickname: "Nickname Changed",  avatar: "Avatar Changed",
    voiceJoin: "Joined Voice",     voiceLeave: "Left Voice",       voiceMove: "Switched Voice Channels",
  };
  return map[kind] || "Server Event";
}
