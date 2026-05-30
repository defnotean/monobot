/**
 * @file packages/eris/database/guildSettings.js
 * @module packages/eris/database/guildSettings
 *
 * Per-server configuration: generic feature toggles + channel / ping-role
 * config, and the persistent admin directives (natural-language behavioral
 * rules). All state lives in the shared `data.guild_settings` cache held in
 * core; mutations mark the bucket dirty via core's debounced `save()`.
 */
import { data, save } from "./core.js";

function ensureGuild(guildId) {
  if (!data.guild_settings[guildId]) data.guild_settings[guildId] = {};
  return data.guild_settings[guildId];
}

export function getGuildSettings(guildId) {
  return data.guild_settings[guildId] || {};
}

export function setGuildSetting(guildId, key, value) {
  const s = ensureGuild(guildId);
  s[key] = value;
  save("guild_settings");
}

// ─── Directives: persistent behavioral rules given by admins in natural language ──
export function getDirectives(guildId) {
  return ensureGuild(guildId).directives || [];
}
export function addDirective(guildId, text, channelId = null, addedBy = null) {
  const g = ensureGuild(guildId);
  if (!g.directives) g.directives = [];
  if (g.directives.length >= 50) return { success: false, reason: "max 50 directives per server" };
  const lower = text.toLowerCase().trim();
  if (g.directives.some(d => d.text.toLowerCase().trim() === lower)) return { success: false, reason: "duplicate directive" };
  g.directives.push({ text: text.substring(0, 300), channel: channelId || null, addedBy, addedAt: Date.now() });
  save("guild_settings");
  return { success: true, index: g.directives.length - 1 };
}
export function removeDirective(guildId, indexOrKeyword) {
  const g = ensureGuild(guildId);
  if (!g.directives?.length) return { success: false, reason: "no directives saved" };
  const idx = typeof indexOrKeyword === "number" ? indexOrKeyword : g.directives.findIndex(d => d.text.toLowerCase().includes(String(indexOrKeyword).toLowerCase()));
  if (idx < 0 || idx >= g.directives.length) return { success: false, reason: "directive not found" };
  const removed = g.directives.splice(idx, 1)[0];
  save("guild_settings");
  return { success: true, removed: removed.text };
}

/**
 * Get a specific feature config for a guild.
 * Returns defaults merged with any saved overrides.
 */
export function getFeatureConfig(guildId, feature) {
  const defaults = {
    economy: { enabled: true, channel_id: null, ping_role_ids: [] },
    gambling: { enabled: true, channel_id: null, ping_role_ids: [] },
    events: { enabled: false, channel_id: null, ping_role_ids: [] },
    confessions: { enabled: true, channel_id: null, ping_role_ids: [] },
    boss_battles: { enabled: true, channel_id: null, ping_role_ids: [] },
    stocks: { enabled: true, channel_id: null, ping_role_ids: [] },
    heists: { enabled: true, channel_id: null, ping_role_ids: [] },
    territories: { enabled: true, channel_id: null, ping_role_ids: [] },
    pets: { enabled: true },
    daily_challenges: { enabled: true, channel_id: null, ping_role_ids: [] },
    achievements: { enabled: true, channel_id: null },
    loans: { enabled: true },
  };
  const guild = getGuildSettings(guildId);
  const saved = guild[`feature_${feature}`] || {};
  return { ...(defaults[feature] || { enabled: true }), ...saved };
}

export function setFeatureConfig(guildId, feature, updates) {
  const s = ensureGuild(guildId);
  const key = `feature_${feature}`;
  s[key] = { ...(s[key] || {}), ...updates };
  save("guild_settings");
}
