/**
 * @file packages/irene/database/conversations.js
 * @module irene/database/conversations
 *
 * Conversation memory (top-level data.conversations slice) plus the per-guild
 * AI configuration that rides alongside it: per-channel personalities, server
 * persona, bad-word filter, auto-escalation policy, and server stats channels.
 */

import { data, save, ensureGuild } from "./core.js";
import { ESCALATION_DEFAULTS, withDefaults } from "./schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATIONS, PERSONALITIES, BAD WORDS, ESCALATION & STATS CHANNELS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Conversation Memory ──────────────────────────────────────────────────────

export function saveConversation(channelKey, history) {
  if (!data.conversations) data.conversations = {};
  // Limit to last 20 messages to avoid bloat
  data.conversations[channelKey] = history.slice(-20);

  // Prevent unbounded growth of the JSON data bundle
  const keys = Object.keys(data.conversations);
  if (keys.length > 5000) {
    // Delete the oldest 100 conversations to free up space
    for (let i = 0; i < 100; i++) {
      delete data.conversations[keys[i]];
    }
  }

  save("conversations");
}

export function loadConversations() {
  const result = new Map();
  if (!data.conversations) return result;
  for (const [key, hist] of Object.entries(data.conversations)) {
    if (Array.isArray(hist) && hist.length > 0) result.set(key, hist);
  }
  return result;
}

export function getConversationsData() {
  return data.conversations || {};
}

export function deleteConversation(key) {
  if (!data.conversations) return false;
  if (data.conversations[key]) {
    delete data.conversations[key];
    save("conversations");
    return true;
  }
  // Partial match
  let deleted = false;
  for (const k of Object.keys(data.conversations)) {
    if (k.includes(key)) { delete data.conversations[k]; deleted = true; }
  }
  if (deleted) save("conversations");
  return deleted;
}

// ─── Per-Channel Personality ──────────────────────────────────────────────────

export function setChannelPersonality(guildId, channelId, prompt) {
  const s = ensureGuild(guildId);
  if (!s.channel_personalities) s.channel_personalities = {};
  if (prompt) {
    s.channel_personalities[channelId] = prompt;
  } else {
    delete s.channel_personalities[channelId];
  }
  save("guild_settings");
}

export function getChannelPersonality(guildId, channelId) {
  return data.guild_settings[guildId]?.channel_personalities?.[channelId] ?? null;
}

// ─── Server Persona ───────────────────────────────────────────────────────────
// Allows each guild to override the bot's name + personality independently.
// { name: string, personality: string } — either field may be absent (falls back to default).

export function setServerPersona(guildId, persona) {
  const s = ensureGuild(guildId);
  if (persona) {
    s.server_persona = persona; // { name, personality }
  } else {
    delete s.server_persona;
  }
  save("guild_settings");
}

export function getServerPersona(guildId) {
  return data.guild_settings[guildId]?.server_persona ?? null;
}

// ─── Bad Word Filter ──────────────────────────────────────────────────────────

export function setBadWords(guildId, words) {
  ensureGuild(guildId).bad_words = words;
  save("guild_settings");
}

export function getBadWords(guildId) {
  return data.guild_settings[guildId]?.bad_words ?? [];
}

// ─── Auto-Escalation ──────────────────────────────────────────────────────────

export function setEscalation(guildId, config) {
  ensureGuild(guildId).escalation = config;
  save("guild_settings");
}

export function getEscalation(guildId) {
  // Partial-policy admins (e.g. only mute_at set) must still observe
  // null at unset tiers — merge over ESCALATION_DEFAULTS rather than
  // returning the raw stored row.
  return withDefaults(ESCALATION_DEFAULTS, data.guild_settings[guildId]?.escalation);
}

// ─── Server Stats Channels ────────────────────────────────────────────────────

export function setStatsChannels(guildId, config) {
  ensureGuild(guildId).stats_channels = config;
  save("guild_settings");
}

export function getStatsChannels(guildId) {
  return data.guild_settings[guildId]?.stats_channels ?? null;
}
