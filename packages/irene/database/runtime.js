/**
 * @file packages/irene/database/runtime.js
 * @module irene/database/runtime
 *
 * Persistent runtime state that must survive a Render restart: saved music
 * queues (data.saved_queues), temp VCs (data.temp_vcs), lockdown timers, and
 * auto-slowmode timers (both in guild_settings).
 */

import { data, save, ensureGuild, _markEntity } from "./core.js";

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT RUNTIME STATE — music queues, temp VCs, lockdown, auto-slowmode
// ═══════════════════════════════════════════════════════════════════════════

// ─── Saved Music Queues (persist across restarts) ────────────────────────────

export function saveQueue(guildId, queueData) {
  if (!data.saved_queues) data.saved_queues = {};
  data.saved_queues[guildId] = { ...queueData, savedAt: Date.now() };
  _markEntity("saved_queues", guildId);
  save("saved_queues");
}

export function getSavedQueues() {
  return data.saved_queues ?? {};
}

export function clearSavedQueue(guildId) {
  if (data.saved_queues?.[guildId]) {
    delete data.saved_queues[guildId];
    _markEntity("saved_queues", guildId);
    save("saved_queues");
  }
}

export function clearAllSavedQueues() {
  data.saved_queues = {};
  save("saved_queues");
}

// ─── Temp VC State (persist across restarts) ─────────────────────────────────
// Stored at top-level data.temp_vcs rather than inside guild_settings["_global"]
// to keep the guild_settings namespace clean and avoid confusion with real guilds.

export function saveTempVc(channelId, vcData) {
  if (!vcData) vcData = {};
  if (!data.temp_vcs) data.temp_vcs = {};
  data.temp_vcs[channelId] = vcData;
  save("temp_vcs");
}

export function deleteTempVc(channelId) {
  if (data.temp_vcs?.[channelId]) {
    delete data.temp_vcs[channelId];
    save("temp_vcs");
  }
}

export function getAllTempVcs() {
  return data.temp_vcs ?? {};
}

export function clearAllTempVcs() {
  data.temp_vcs = {};
  save("temp_vcs");
}

// ─── Lockdown State ──────────────────────────────────────────────────────────

export function saveLockdown(guildId, expiresAt) {
  ensureGuild(guildId).lockdown_expires = expiresAt;
  save("guild_settings");
}

export function clearLockdown(guildId) {
  const s = data.guild_settings[guildId];
  if (s) { delete s.lockdown_expires; _markEntity("guild_settings", guildId); save("guild_settings"); }
}

export function getLockdown(guildId) {
  return data.guild_settings[guildId]?.lockdown_expires ?? null;
}

// ─── Auto-Slowmode State ─────────────────────────────────────────────────────

export function saveSlowmode(channelId, guildId, expiresAt) {
  ensureGuild(guildId).auto_slowmode = ensureGuild(guildId).auto_slowmode ?? {};
  ensureGuild(guildId).auto_slowmode[channelId] = expiresAt;
  save("guild_settings");
}

export function clearSlowmode(channelId, guildId) {
  const s = data.guild_settings[guildId];
  if (s?.auto_slowmode?.[channelId]) { delete s.auto_slowmode[channelId]; _markEntity("guild_settings", guildId); save("guild_settings"); }
}

export function getAutoSlowmodes(guildId) {
  return data.guild_settings[guildId]?.auto_slowmode ?? {};
}
