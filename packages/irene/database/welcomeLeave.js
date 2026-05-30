/**
 * @file packages/irene/database/welcomeLeave.js
 * @module irene/database/welcomeLeave
 *
 * Welcome embed customization, DM-welcome settings, and leave messages. All
 * backed by data.guild_settings[guildId] via save("guild_settings").
 */

import { data, save, ensureGuild } from "./core.js";
import { DM_WELCOME_DEFAULTS, LEAVE_DEFAULTS, withDefaults } from "./schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// WELCOME / DM-WELCOME / LEAVE — embed customization & message templates
// ═══════════════════════════════════════════════════════════════════════════

// ─── Welcome Embed Customization ─────────────────────────────────────────────

export function getWelcomeEmbed(guildId) {
  return data.guild_settings[guildId]?.welcome_embed ?? null;
}

/**
 * Merge partial embedConfig into the stored config.
 * Pass null to fully reset all customizations.
 */
export function setWelcomeEmbed(guildId, embedConfig) {
  const s = ensureGuild(guildId);
  if (embedConfig === null) {
    delete s.welcome_embed;
  } else {
    s.welcome_embed = { ...(s.welcome_embed ?? {}), ...embedConfig };
  }
  save("guild_settings");
}

// ─── DM Welcome ───────────────────────────────────────────────────────────────

export function setDmWelcome(guildId, enabled, message) {
  const s = ensureGuild(guildId);
  s.dm_welcome_enabled = enabled;
  if (message !== undefined) s.dm_welcome_message = message;
  save("guild_settings");
}

export function getDmWelcome(guildId) {
  // Build the slice projection from stored snake_case keys, then merge over
  // DM_WELCOME_DEFAULTS. Only project keys that are actually set so that
  // unset fields fall through to defaults via withDefaults.
  const s = data.guild_settings[guildId];
  const stored = {};
  if (s?.dm_welcome_enabled !== undefined) stored.enabled = s.dm_welcome_enabled;
  if (s?.dm_welcome_message !== undefined) stored.message = s.dm_welcome_message;
  return withDefaults(DM_WELCOME_DEFAULTS, stored);
}

// ─── Leave Messages ───────────────────────────────────────────────────────────

export function setLeaveChannel(guildId, channelId, message) {
  const s = ensureGuild(guildId);
  s.leave_channel = channelId;
  if (message !== undefined) s.leave_message = message;
  save("guild_settings");
}

export function getLeaveSettings(guildId) {
  // Project stored snake_case fields into the slice shape, then merge.
  // Only project keys that are set so unset ones inherit the default.
  // Explicit-null channel id (admin cleared the leave channel) is preserved.
  const s = data.guild_settings[guildId];
  const stored = {};
  if (s?.leave_channel !== undefined) stored.channelId = s.leave_channel;
  if (s?.leave_message !== undefined) stored.message = s.leave_message;
  return withDefaults(LEAVE_DEFAULTS, stored);
}
