/**
 * @file packages/irene/database/extras.js
 * @module irene/database/extras
 *
 * Giveaways + highlights (top-level cache slices), per-guild giveaway ping
 * roles, voice stats, auto-responders, feature toggles, and the per-guild audit
 * log — all the smaller per-guild collections that ride on guild_settings.
 */

import { data, save, ensureGuild } from "./core.js";

// ═══════════════════════════════════════════════════════════════════════════
// GIVEAWAYS, HIGHLIGHTS, VOICE STATS & AUTO-RESPONDERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Giveaway Persistence ───────────────────────────────────────────────────

export function getGiveawayDb() {
  return data.giveaways ?? [];
}

export function saveGiveawayDb(giveawayArray) {
  data.giveaways = giveawayArray;
  save("giveaways");
}

export function getGiveawayPingRoles(guildId) {
  return data.guild_settings[guildId]?.giveaway_ping_role_ids ?? [];
}

export function setGiveawayPingRoles(guildId, roleIds) {
  ensureGuild(guildId).giveaway_ping_role_ids = roleIds;
  save("guild_settings");
}

// ─── Highlight Persistence ──────────────────────────────────────────────────

export function getHighlightDb() {
  return data.highlights ?? {};
}

export function saveHighlightDb(highlightObj) {
  data.highlights = highlightObj;
  save("highlights");
}

// ─── Voice Stats ──────────────────────────────────────────────────────────

export function getVoiceStats(guildId) {
  return data.guild_settings[guildId]?.voice_stats ?? {};
}

export function addVoiceTime(guildId, userId, minutes) {
  const s = ensureGuild(guildId);
  if (!s.voice_stats) s.voice_stats = {};
  if (!s.voice_stats[userId]) s.voice_stats[userId] = { total_minutes: 0, sessions: 0 };
  s.voice_stats[userId].total_minutes += minutes;
  s.voice_stats[userId].sessions += 1;
  save("guild_settings");
}

// ─── Auto-Responders ──────────────────────────────────────────────────────

export function getAutoResponders(guildId) {
  return data.guild_settings[guildId]?.auto_responders ?? [];
}

export function addAutoResponder(guildId, trigger, response, createdBy) {
  if (!trigger || typeof trigger !== "string" || !trigger.trim()) return false;
  if (!response || typeof response !== "string" || !response.trim()) return false;
  if (trigger.length > 100) return false; // Max trigger length
  if (response.length > 500) return false; // Max response length
  const s = ensureGuild(guildId);
  if (!s.auto_responders) s.auto_responders = [];
  s.auto_responders.push({ trigger: trigger.toLowerCase(), response, created_by: createdBy, uses: 0 });
  save("guild_settings");
  return true;
}

export function removeAutoResponder(guildId, trigger) {
  const s = ensureGuild(guildId);
  if (!s.auto_responders) return false;
  const before = s.auto_responders.length;
  s.auto_responders = s.auto_responders.filter(a => a.trigger !== trigger.toLowerCase());
  save("guild_settings");
  return s.auto_responders.length < before;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE TOGGLES & AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════

// ─── Feature Toggles ────────────────────────────────────────────────────────

export function isFeatureEnabled(guildId, feature) {
  const s = data.guild_settings[guildId];
  if (!s) return true; // default enabled
  return s[`${feature}_enabled`] !== false;
}

export function setFeatureToggle(guildId, feature, enabled) {
  const s = ensureGuild(guildId);
  s[`${feature}_enabled`] = enabled;
  save("guild_settings");
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export function logAudit(guildId, action, userId, details) {
  const s = ensureGuild(guildId);
  if (!s.audit_log) s.audit_log = [];
  s.audit_log.push({
    action,
    userId,
    details,
    timestamp: new Date().toISOString(),
  });
  // Keep only last 100 entries per guild
  if (s.audit_log.length > 100) s.audit_log = s.audit_log.slice(-100);
  save("guild_settings");
}
