/**
 * @file packages/irene/database/tickets.js
 * @module irene/database/tickets
 *
 * Ticket system configuration — roles (mod/view/ping), welcome & panel embeds,
 * ticket types, auto-category resolution, and live role resolution. All state
 * lives under data.guild_settings[guildId] and persists via
 * save("guild_settings").
 */

import { ensureGuild, save } from "./core.js";
import { _cleanRoleIds } from "./guildSettings.js";

// ═══════════════════════════════════════════════════════════════════════════
// TICKET SYSTEM — roles, welcome/panel embeds, types, auto-category resolution
// ═══════════════════════════════════════════════════════════════════════════

// Legacy: both pings AND grants view access in one call. Kept as a shorthand.
// New code should prefer setTicketViewRoles / setTicketPingRoles separately.
export function setTicketModRoles(guildId, roleIds) {
  const clean = _cleanRoleIds(roleIds);
  const gs = ensureGuild(guildId);
  gs.ticket_mod_role_ids  = clean;
  gs.ticket_view_role_ids = clean;
  gs.ticket_ping_role_ids = clean;
  save("guild_settings");
}

// Roles granted ViewChannel + SendMessages on every new ticket. [] = nobody
// beyond the opener + bot. Category-level perms can still grant broader
// access without adding anything here. Also clears the legacy combined
// ticket_mod_role_ids field so once an admin touches the new split settings,
// the old field stops acting as a fallback (which would re-apply old
// ping+view intentions the admin explicitly narrowed).
export function setTicketViewRoles(guildId, roleIds) {
  const gs = ensureGuild(guildId);
  gs.ticket_view_role_ids = _cleanRoleIds(roleIds);
  if (!Array.isArray(gs.ticket_ping_role_ids)) gs.ticket_ping_role_ids = [];
  delete gs.ticket_mod_role_ids;
  save("guild_settings");
}

// Roles mentioned in the welcome message when a ticket opens. [] = no ping.
// Independent of view access — you can ping without granting view (e.g. alert
// a staff role that then has to react) or grant view without pinging.
export function setTicketPingRoles(guildId, roleIds) {
  const gs = ensureGuild(guildId);
  gs.ticket_ping_role_ids = _cleanRoleIds(roleIds);
  if (!Array.isArray(gs.ticket_view_role_ids)) gs.ticket_view_role_ids = [];
  delete gs.ticket_mod_role_ids;
  save("guild_settings");
}

// Welcome embed (shown INSIDE each new ticket channel). null = default.
// color accepts hex strings with or without #; stored as integer or null.
/**
 * @param {string} guildId
 * @param {{ title?: any, description?: any, color?: any }} [opts]
 */
export function setTicketWelcome(guildId, { title, description, color } = {}) {
  const gs = ensureGuild(guildId);
  if (title !== undefined) gs.ticket_welcome_title = title ? String(title).slice(0, 256) : null;
  if (description !== undefined) gs.ticket_welcome_description = description ? String(description).slice(0, 4000) : null;
  if (color !== undefined) gs.ticket_welcome_color = _parseColor(color);
  save("guild_settings");
}

// Panel embed (the "Support Tickets / click the button" message posted in a
// channel). null on any field = fall back to the default for that field.
// button_label + button_emoji are bundled here because they ship with the
// embed as one unit.
/**
 * @param {string} guildId
 * @param {{ title?: any, description?: any, color?: any, button_label?: any, button_emoji?: any }} [opts]
 */
export function setTicketPanel(guildId, { title, description, color, button_label, button_emoji } = {}) {
  const gs = ensureGuild(guildId);
  if (title        !== undefined) gs.ticket_panel_title        = title        ? String(title).slice(0, 256)   : null;
  if (description  !== undefined) gs.ticket_panel_description  = description  ? String(description).slice(0, 4000) : null;
  if (color        !== undefined) gs.ticket_panel_color        = _parseColor(color);
  if (button_label !== undefined) gs.ticket_panel_button_label = button_label ? String(button_label).slice(0, 80) : null;
  if (button_emoji !== undefined) gs.ticket_panel_button_emoji = button_emoji ? String(button_emoji).slice(0, 64) : null;
  save("guild_settings");
}

// Remember where we last posted a panel so the next "Post Panel" click can
// edit that message instead of spamming duplicates. null clears it.
export function setTicketPanelMessage(guildId, channelId, messageId) {
  const gs = ensureGuild(guildId);
  if (channelId && messageId) {
    gs.ticket_panel_channel_id = String(channelId);
    gs.ticket_panel_message_id = String(messageId);
  } else {
    delete gs.ticket_panel_channel_id;
    delete gs.ticket_panel_message_id;
  }
  save("guild_settings");
}

// Ticket TYPES — each type routes to its own category. Admins can define
// multiple types (e.g. Support/Reports/Appeals) and the panel renders one
// button per type. A ticket opened via a type button lands in that type's
// category. If no types are defined, the panel uses the legacy single-button
// flow with ticket_category_id as the destination.
//
// Type shape:
//   { key, label, emoji?, category_id?, style? }
// - key       — unique identifier within the guild, 1–50 chars, [a-z0-9_-]
// - label     — button text, max 80 chars
// - emoji     — unicode emoji or custom <:name:id>, optional
// - category_id — where tickets of this type go. If null/missing/deleted,
//                falls back to ticket_category_id at ticket-creation time.
// - style     — Discord ButtonStyle name: "Primary"|"Secondary"|"Success"|"Danger"
//                Defaults to Primary. Link is NOT allowed (buttons must be
//                interactive to open a ticket).
const TICKET_TYPE_KEY = /^[a-z0-9_-]{1,50}$/;
const ALLOWED_BUTTON_STYLES = new Set(["Primary", "Secondary", "Success", "Danger"]);

function _sanitizeTicketType(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key || "").trim().toLowerCase();
  if (!TICKET_TYPE_KEY.test(key)) return null;
  const label = String(raw.label || raw.title || key).trim().slice(0, 80);
  if (!label) return null;
  const out = { key, label };
  if (raw.emoji)        out.emoji = String(raw.emoji).trim().slice(0, 64);
  if (raw.category_id)  out.category_id = String(raw.category_id).trim();
  if (raw.style && ALLOWED_BUTTON_STYLES.has(String(raw.style))) out.style = String(raw.style);
  return out;
}

// Replace the entire types list. Pass [] to clear. Duplicate keys are
// deduped (last write wins). Invalid entries are silently dropped so a
// half-bad AI call can still land the good entries.
export function setTicketTypes(guildId, types) {
  const gs = ensureGuild(guildId);
  const seen = new Map();
  if (Array.isArray(types)) {
    for (const t of types) {
      const clean = _sanitizeTicketType(t);
      if (clean) seen.set(clean.key, clean);
    }
  }
  gs.ticket_types = [...seen.values()];
  save("guild_settings");
  return gs.ticket_types;
}

// Add a single type (or update an existing one with the same key).
export function addTicketType(guildId, type) {
  const clean = _sanitizeTicketType(type);
  if (!clean) return null;
  const gs = ensureGuild(guildId);
  const list = Array.isArray(gs.ticket_types) ? [...gs.ticket_types] : [];
  const idx = list.findIndex((t) => t.key === clean.key);
  if (idx >= 0) list[idx] = clean;
  else list.push(clean);
  gs.ticket_types = list;
  save("guild_settings");
  return clean;
}

// Remove by key. Returns true if something was removed.
export function removeTicketType(guildId, key) {
  const k = String(key || "").toLowerCase();
  const gs = ensureGuild(guildId);
  if (!Array.isArray(gs.ticket_types)) return false;
  const before = gs.ticket_types.length;
  gs.ticket_types = gs.ticket_types.filter((t) => t.key !== k);
  if (gs.ticket_types.length !== before) { save("guild_settings"); return true; }
  return false;
}

// Auto-resolve mode: save a CATEGORY KEYWORD instead of frozen role IDs.
// When a ticket opens, the creator resolves this keyword against the live
// guild roles via the categorizer. Effect: add a new role with mod perms
// later and it automatically joins the ticket view/ping set — no need to
// re-run setup. Pass null to clear.
//
// kind: "view" | "ping"
// category: "admin" | "moderator" | "helper" | "staff" | "trusted" | null
export function setTicketAutoCategory(guildId, kind, category) {
  if (kind !== "view" && kind !== "ping") return;
  const gs = ensureGuild(guildId);
  const field = kind === "view" ? "ticket_view_auto_category" : "ticket_ping_auto_category";
  if (category) gs[field] = String(category).toLowerCase();
  else delete gs[field];
  save("guild_settings");
}

// Explicitly pin the panel to a specific channel (without a message yet).
// Used when an admin picks a panel channel up front — Post Panel will then
// post there instead of auto-creating an #open-ticket channel under the
// ticket category. Moving to a different channel invalidates the stored
// message id (can't edit a message that's no longer in-scope).
export function setTicketPanelChannel(guildId, channelId) {
  const gs = ensureGuild(guildId);
  if (channelId) {
    const next = String(channelId);
    if (gs.ticket_panel_channel_id && gs.ticket_panel_channel_id !== next) {
      delete gs.ticket_panel_message_id;
    }
    gs.ticket_panel_channel_id = next;
  } else {
    delete gs.ticket_panel_channel_id;
    delete gs.ticket_panel_message_id;
  }
  save("guild_settings");
}

// Accepts: number, "#RRGGBB", "RRGGBB", "0xRRGGBB". Returns int or null.
function _parseColor(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(0xFFFFFF, Math.floor(value)));
  const raw = String(value).trim().replace(/^#|^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
  return parseInt(raw, 16);
}

// Resolve the effective settings for a guild.
export function getTicketConfig(guildId) {
  const gs = ensureGuild(guildId);
  return {
    category_id:   gs.ticket_category_id || null,
    types:         Array.isArray(gs.ticket_types) ? gs.ticket_types : [],
    view_role_ids: Array.isArray(gs.ticket_view_role_ids) ? gs.ticket_view_role_ids : [],
    ping_role_ids: Array.isArray(gs.ticket_ping_role_ids) ? gs.ticket_ping_role_ids : [],
    view_auto_category: gs.ticket_view_auto_category || null,
    ping_auto_category: gs.ticket_ping_auto_category || null,
    welcome_title:       gs.ticket_welcome_title || null,
    welcome_description: gs.ticket_welcome_description || null,
    welcome_color:       typeof gs.ticket_welcome_color === "number" ? gs.ticket_welcome_color : null,
    panel_title:         gs.ticket_panel_title || null,
    panel_description:   gs.ticket_panel_description || null,
    panel_color:         typeof gs.ticket_panel_color === "number" ? gs.ticket_panel_color : null,
    panel_button_label:  gs.ticket_panel_button_label || null,
    panel_button_emoji:  gs.ticket_panel_button_emoji || null,
    panel_channel_id:    gs.ticket_panel_channel_id || null,
    panel_message_id:    gs.ticket_panel_message_id || null,
  };
}

// Resolve the effective view/ping role IDs for a guild at THIS moment.
// Takes the explicit pinned IDs and unions them with a live lookup against
// the auto-category (if set). The result is what should be written into the
// ticket channel's permission overwrites / ping content. Pass the guild so
// the categorizer can see the live roles cache.
export async function resolveTicketRoles(guild) {
  const cfg = getTicketConfig(guild.id);
  const { getRolesByCategory } = await import("@defnotean/shared/roleCategorizer");
  const _expand = (explicitIds, autoCat) => {
    const out = new Set();
    for (const id of explicitIds || []) if (guild.roles.cache.has(id)) out.add(id);
    if (autoCat) {
      for (const role of getRolesByCategory(guild, autoCat)) out.add(role.id);
    }
    return [...out];
  };
  return {
    view_role_ids: _expand(cfg.view_role_ids, cfg.view_auto_category),
    ping_role_ids: _expand(cfg.ping_role_ids, cfg.ping_auto_category),
  };
}
