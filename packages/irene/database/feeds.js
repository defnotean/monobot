/**
 * @file packages/irene/database/feeds.js
 * @module irene/database/feeds
 *
 * External feed configuration stored under data.guild_settings[guildId]: RSS
 * patch news, Twitch live notifications, TTS channels/voice, YouTube feeds, and
 * GitHub feeds.
 */

import { data, save, ensureGuild } from "./core.js";

// ═══════════════════════════════════════════════════════════════════════════
// EXTERNAL FEEDS — RSS patch news, Twitch live, TTS, YouTube, GitHub
// ═══════════════════════════════════════════════════════════════════════════

// ─── Patch Feeds (RSS Game News) ─────────────────────────────────────────────

export function getPatchFeeds(guildId) {
  return data.guild_settings[guildId]?.patch_feeds ?? { channel_id: null, feeds: [] };
}

export function setPatchFeeds(guildId, config) {
  ensureGuild(guildId).patch_feeds = config;
  save("guild_settings");
}

export function getPatchLastSeen(guildId) {
  return data.guild_settings[guildId]?.patch_last_seen ?? {};
}

export function setPatchLastSeen(guildId, key, value) {
  const s = ensureGuild(guildId);
  if (!s.patch_last_seen) s.patch_last_seen = {};
  s.patch_last_seen[key] = value;
  save("guild_settings");
}

// ─── Twitch Live Notifications ───────────────────────────────────────────────

export function getTwitchConfig(guildId) {
  return data.guild_settings[guildId]?.twitch ?? { channel_id: null, streamers: [], ping_role_id: null, ping_role_ids: [], auto_detect: false };
}

export function setTwitchConfig(guildId, config) {
  ensureGuild(guildId).twitch = config;
  save("guild_settings");
}

// ─── TTS Channels ────────────────────────────────────────────────────────────

export function getTtsChannels(guildId) {
  return data.guild_settings[guildId]?.tts_channels ?? [];
}

export function setTtsChannels(guildId, channels) {
  ensureGuild(guildId).tts_channels = channels;
  save("guild_settings");
}

export function getTtsVoice(guildId) {
  return data.guild_settings[guildId]?.tts_voice ?? "Kore";
}

export function setTtsVoice(guildId, voice) {
  ensureGuild(guildId).tts_voice = voice;
  save("guild_settings");
}

// ─── YouTube Feeds ──────────────────────────────────────────────────────────

export function getYoutubeConfig(guildId) {
  return data.guild_settings[guildId]?.youtube ?? [];
}

export function setYoutubeConfig(guildId, config) {
  ensureGuild(guildId).youtube = config;
  save("guild_settings");
}

// ─── GitHub Feeds ───────────────────────────────────────────────────────────

export function getGithubConfig(guildId) {
  return data.guild_settings[guildId]?.github ?? [];
}

export function setGithubConfig(guildId, config) {
  ensureGuild(guildId).github = config;
  save("guild_settings");
}
