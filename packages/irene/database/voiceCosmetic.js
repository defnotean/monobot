/**
 * @file packages/irene/database/voiceCosmetic.js
 * @module irene/database/voiceCosmetic
 *
 * AFK settings, temp-VC creation config, color roles, and seasonal palettes.
 * All stored under data.guild_settings[guildId] via save("guild_settings").
 */

import { data, save, ensureGuild } from "./core.js";

// ═══════════════════════════════════════════════════════════════════════════
// AFK / TEMP-VC / COLOR ROLES / SEASONAL PALETTES — voice & cosmetic config
// ═══════════════════════════════════════════════════════════════════════════

export function setAfkSettings(guildId, channelId, timeoutMinutes) {
  const s = ensureGuild(guildId);
  s.afk_channel_id = channelId;
  s.afk_timeout_minutes = timeoutMinutes;
  save("guild_settings");
}

export function setCreateVcChannel(guildId, channelId) {
  ensureGuild(guildId).create_vc_channel_id = channelId;
  save("guild_settings");
}

export function setVcTemplate(guildId, template) {
  ensureGuild(guildId).vc_template = template;
  save("guild_settings");
}

export function getVcTemplate(guildId) {
  return data.guild_settings[guildId]?.vc_template ?? null; // null = use smart auto mode
}

export function setVcDefaultLimit(guildId, limit) {
  ensureGuild(guildId).vc_default_limit = limit ?? 0;
  save("guild_settings");
}

export function getVcDefaultLimit(guildId) {
  return data.guild_settings[guildId]?.vc_default_limit ?? 0;
}

export function setVcNamingMode(guildId, mode) {
  ensureGuild(guildId).vc_naming_mode = mode;
  save("guild_settings");
}

export function getVcNamingMode(guildId) {
  return data.guild_settings[guildId]?.vc_naming_mode ?? "smart"; // smart | anonymous | random
}

export function setVcRichPresence(guildId, enabled) {
  ensureGuild(guildId).vc_rich_presence = enabled;
  save("guild_settings");
}

export function getVcRichPresence(guildId) {
  return data.guild_settings[guildId]?.vc_rich_presence ?? true;
}

export function setVcTextChannels(guildId, enabled) {
  ensureGuild(guildId).vc_text_channels = enabled;
  save("guild_settings");
}

export function getVcTextChannels(guildId) {
  return data.guild_settings[guildId]?.vc_text_channels ?? false;
}

export function setColorRoles(guildId, roleIds) {
  ensureGuild(guildId).color_role_ids = roleIds;
  save("guild_settings");
}

export function getColorRoles(guildId) {
  return data.guild_settings[guildId]?.color_role_ids ?? [];
}

export function setSeasonalColors(guildId, enabled) {
  ensureGuild(guildId).seasonal_colors = enabled;
  save("guild_settings");
}

export function getSeasonalColors(guildId) {
  return data.guild_settings[guildId]?.seasonal_colors ?? false;
}

export function setLastSeasonalPalette(guildId, paletteName) {
  ensureGuild(guildId).last_seasonal_palette = paletteName;
  save("guild_settings");
}

export function getLastSeasonalPalette(guildId) {
  return data.guild_settings[guildId]?.last_seasonal_palette ?? null;
}
