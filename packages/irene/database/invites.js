/**
 * @file packages/irene/database/invites.js
 * @module irene/database/invites
 *
 * Invite tracking (join/leave history + leaderboard), temp bans, invite filter
 * settings, and sticky messages — all stored under data.guild_settings[guildId]
 * and persisted via save("guild_settings").
 */

import { data, save, ensureGuild, _markEntity } from "./core.js";

// ═══════════════════════════════════════════════════════════════════════════
// INVITE TRACKING, TEMP BANS, INVITE FILTER & STICKY MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

// ─── INVITE TRACKING ───────────────────────────────────────────────────────

/** Record a new member join with invite data */
export function recordInviteJoin(guildId, userId, username, inviteCode, inviterId, inviterTag) {
  const s = ensureGuild(guildId);
  if (!s.invite_history) s.invite_history = [];
  s.invite_history.push({
    userId, username, inviteCode,
    inviterId: inviterId || null,
    inviterTag: inviterTag || null,
    timestamp: new Date().toISOString(),
    left: false,
    leftAt: null,
  });
  if (s.invite_history.length > 500) s.invite_history = s.invite_history.slice(-500);
  save("guild_settings");
}

/** Mark a member as having left the server */
export function markInviteLeave(guildId, userId) {
  const s = ensureGuild(guildId);
  if (!s.invite_history) return;
  // Mark the most recent join for this user
  for (let i = s.invite_history.length - 1; i >= 0; i--) {
    if (s.invite_history[i].userId === userId && !s.invite_history[i].left) {
      s.invite_history[i].left = true;
      s.invite_history[i].leftAt = new Date().toISOString();
      save("guild_settings");
      return;
    }
  }
}

/** Get recent invite join history */
export function getInviteHistory(guildId, limit = 20) {
  const s = ensureGuild(guildId);
  return (s.invite_history || []).slice(-limit).reverse();
}

/** Get invite leaderboard — top inviters with counts */
export function getInviteLeaderboard(guildId) {
  const s = ensureGuild(guildId);
  const history = s.invite_history || [];
  const counts = {};
  for (const entry of history) {
    if (!entry.inviterId) continue;
    if (!counts[entry.inviterId]) counts[entry.inviterId] = { tag: entry.inviterTag, total: 0, stayed: 0, left: 0 };
    counts[entry.inviterId].total++;
    if (entry.inviterTag) counts[entry.inviterId].tag = entry.inviterTag; // Keep latest tag
    if (entry.left) counts[entry.inviterId].left++;
    else counts[entry.inviterId].stayed++;
  }
  return Object.entries(counts)
    .map(([id, data]) => ({ userId: id, ...data }))
    .sort((a, b) => b.total - a.total);
}

/** Get all joins that came through a specific inviter */
export function getInvitesBy(guildId, userId) {
  const s = ensureGuild(guildId);
  return (s.invite_history || []).filter(e => e.inviterId === userId);
}

// ─── TEMP BANS ─────────────────────────────────────────────────────────────
export function addTempBan(guildId, userId, username, duration, reason, moderatorId) {
  const s = ensureGuild(guildId);
  if (!s.temp_bans) s.temp_bans = [];
  s.temp_bans.push({
    userId, username, reason,
    moderatorId,
    bannedAt: new Date().toISOString(),
    unbanAt: new Date(Date.now() + duration).toISOString(),
  });
  save("guild_settings");
}

export function getExpiredTempBans() {
  const now = new Date().toISOString();
  const expired = [];
  for (const [guildId, settings] of Object.entries(data.guild_settings)) {
    if (!settings.temp_bans?.length) continue;
    const due = settings.temp_bans.filter(b => b.unbanAt <= now);
    const remaining = settings.temp_bans.filter(b => b.unbanAt > now);
    if (due.length) {
      expired.push(...due.map(b => ({ ...b, guildId })));
      settings.temp_bans = remaining;
      _markEntity("guild_settings", guildId);
      save("guild_settings");
    }
  }
  return expired;
}

export function removeTempBan(guildId, userId) {
  const s = ensureGuild(guildId);
  if (!s.temp_bans) return;
  s.temp_bans = s.temp_bans.filter(b => b.userId !== userId);
  save("guild_settings");
}

// ─── INVITE FILTER ─────────────────────────────────────────────────────────
export function setInviteFilter(guildId, enabled) {
  const s = ensureGuild(guildId);
  s.invite_filter = enabled;
  save("guild_settings");
}

export function setInviteFilterWhitelist(guildId, roleIds) {
  const s = ensureGuild(guildId);
  s.invite_filter_whitelist = roleIds;
  save("guild_settings");
}

// ─── STICKY MESSAGES ───────────────────────────────────────────────────────
export function setStickyMessage(guildId, channelId, content, embedData) {
  const s = ensureGuild(guildId);
  if (!s.sticky_messages) s.sticky_messages = {};
  s.sticky_messages[channelId] = { content, embedData, lastMessageId: null };
  save("guild_settings");
}

export function getStickyMessage(guildId, channelId) {
  const s = ensureGuild(guildId);
  return s.sticky_messages?.[channelId] || null;
}

export function updateStickyMessageId(guildId, channelId, messageId) {
  const s = ensureGuild(guildId);
  if (s.sticky_messages?.[channelId]) {
    s.sticky_messages[channelId].lastMessageId = messageId;
    save("guild_settings");
  }
}

export function removeStickyMessage(guildId, channelId) {
  const s = ensureGuild(guildId);
  if (s.sticky_messages) {
    delete s.sticky_messages[channelId];
    save("guild_settings");
  }
}
