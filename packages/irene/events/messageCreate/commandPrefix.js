// ─── packages/irene/events/messageCreate/commandPrefix.js ─────────────────
// Custom !command handling + sticky messages + auto-responders. These all
// run after auto-mod but before any AI invocation. handleCustomCommand
// short-circuits the orchestrator if it matches; sticky/auto-responders
// are pure side effects that always continue.

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { log } from "../../utils/logger.js";
import { getCustomCommand, getTrustedUsers, getAutoResponders } from "../../database.js";
import { findRole } from "../../ai/executor.js";

// ── Injection sanitizer for user-stored responses ─────────────────────────
// Custom commands and auto-responders are admin-controlled, but their
// stored text still flows into Discord output, so we scrub patterns that
// look like prompt-injection bait before substituting placeholders.
const _INJECTION_STRIP_PATTERNS = [
  /\[SYSTEM\b/gi, /\[INST\b/gi, /<<SYS\b/gi,
  /\bignore\s+previous\b/gi, /\bdisregard\b/gi, /\bnew\s+instructions\b/gi,
  /\byou\s+are\s+now\b/gi, /\bact\s+as\b/gi, /\bpretend\s+to\s+be\b/gi,
];
const _SAFE_PLACEHOLDERS = new Set(["user", "username", "server", "membercount", "channel"]);

export function sanitizeResponse(text) {
  let cleaned = text;
  for (const pat of _INJECTION_STRIP_PATTERNS) cleaned = cleaned.replace(pat, "");
  // Strip suspicious template injections in {} but keep safe placeholders
  cleaned = cleaned.replace(/\{([^}]+)\}/g, (match, inner) => {
    const trimmed = inner.trim().toLowerCase();
    return _SAFE_PLACEHOLDERS.has(trimmed) ? match : "";
  });
  return cleaned.trim();
}

export function memberIsAdmin(member) {
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (getTrustedUsers(member.guild.id).includes(member.id)) return true;
  return false;
}

// ── Custom !command handler ──────────────────────────────────────────────
// Returns true if the message was a custom command (orchestrator short-circuits).
export async function handleCustomCommand(message) {
  if (!message.content.startsWith("!")) return false;

  const trigger = message.content.slice(1).split(/\s+/)[0]?.toLowerCase();
  if (!trigger) return false;

  const cmd = getCustomCommand(message.guild.id, trigger);
  if (!cmd) return false;

  if (cmd.admin_only && !memberIsAdmin(message.member)) {
    await message.reply("nah, that command is admin-only").catch((e) => log(`[Error] ${e.message}`));
    return true;
  }

  if (cmd.auto_delete) await message.delete().catch(() => {});

  let response = sanitizeResponse(cmd.response)
    .replace(/{user}/g, message.author.toString())
    .replace(/{username}/g, message.author.username)
    .replace(/{server}/g, message.guild.name)
    .replace(/{membercount}/g, message.guild.memberCount)
    .replace(/{channel}/g, message.channel.toString());

  if (cmd.role_to_give) {
    const role = findRole(message.guild, cmd.role_to_give);
    if (role) await message.member.roles.add(role).catch(() => {});
  }
  if (cmd.role_to_remove) {
    const role = findRole(message.guild, cmd.role_to_remove);
    if (role) await message.member.roles.remove(role).catch(() => {});
  }

  try {
    if (cmd.embed_title) {
      const rawColor = cmd.embed_color ? parseInt(cmd.embed_color.replace(/^#/, ""), 16) : 0x5865f2;
      const color = isNaN(rawColor) || rawColor < 0 ? 0x5865f2 : Math.min(rawColor, 0xFFFFFF);
      const embed = new EmbedBuilder()
        .setTitle(cmd.embed_title)
        .setColor(color);

      if (response) embed.setDescription(response);
      if (cmd.embed_url) embed.setURL(cmd.embed_url);
      if (cmd.embed_image) embed.setImage(cmd.embed_image);
      if (cmd.embed_thumbnail) embed.setThumbnail(cmd.embed_thumbnail);
      if (cmd.embed_footer) embed.setFooter({ text: cmd.embed_footer });
      if (cmd.embed_author) {
        const authorOpts = { name: cmd.embed_author };
        if (cmd.embed_author_icon) authorOpts.iconURL = cmd.embed_author_icon;
        embed.setAuthor(authorOpts);
      }
      embed.setTimestamp();

      await message.channel.send({ embeds: [embed] });
    } else if (response) {
      await message.channel.send(response);
    }
  } catch (err) {
    log(`[CustomCmd] !${trigger} failed: ${err.message}`);
  }

  return true;
}

// ── Sticky messages — re-post at bottom of channel ────────────────────────
// Debounced to one re-send per 5s per channel.
export async function processStickyMessage(message) {
  try {
    const { getStickyMessage, updateStickyMessageId } = await import("../../database.js");
    const sticky = getStickyMessage(message.guild.id, message.channel.id);
    if (!sticky) return;

    // Debounce — only re-send if >5 seconds since last re-send
    if (!globalThis._stickyCooldowns) globalThis._stickyCooldowns = new Map();
    const _stickyKey = message.channel.id;
    const _stickyLast = globalThis._stickyCooldowns.get(_stickyKey) || 0;
    if (Date.now() - _stickyLast < 5000) return;
    globalThis._stickyCooldowns.set(_stickyKey, Date.now());
    // Delete old sticky
    if (sticky.lastMessageId) {
      try { const old = await message.channel.messages.fetch(sticky.lastMessageId); await old.delete(); } catch {}
    }
    // Re-send sticky at bottom
    const { EmbedBuilder } = await import("discord.js");
    const sendOpts = {};
    if (sticky.content) sendOpts.content = sticky.content;
    if (sticky.embedData) {
      const e = new EmbedBuilder();
      if (sticky.embedData.title) e.setTitle(sticky.embedData.title);
      if (sticky.embedData.description) e.setDescription(sticky.embedData.description.replace(/\\n/g, "\n"));
      if (sticky.embedData.color) e.setColor(typeof sticky.embedData.color === "string" ? parseInt(sticky.embedData.color.replace("#", ""), 16) : sticky.embedData.color);
      if (sticky.embedData.footer) e.setFooter({ text: sticky.embedData.footer });
      sendOpts.embeds = [e];
    }
    const newMsg = await message.channel.send(sendOpts);
    updateStickyMessageId(message.guild.id, message.channel.id, newMsg.id);
  } catch {}
}

// ── Auto-responders (guild only, respects toggle) ─────────────────────────
// Fires once per matching trigger; sanitizes stored response.
export async function processAutoResponders(message) {
  const { isFeatureEnabled: _isEnabled } = await import("../../database.js");
  if (!_isEnabled(message.guild?.id, "auto_responders")) return;
  const autoResponders = getAutoResponders(message.guild?.id) || [];
  for (const ar of autoResponders) {
    if (message.content.toLowerCase().includes(ar.trigger)) {
      await message.reply(sanitizeResponse(ar.response)).catch(() => {});
      ar.uses++;
      break;
    }
  }
}
