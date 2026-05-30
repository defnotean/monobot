/**
 * @file packages/irene/database/engagement.js
 * @module irene/database/engagement
 *
 * Reaction roles (per-guild), reminders + scheduled tasks (top-level slices
 * with monotonic IDs), and starboard config + entry tracking.
 */

import { data, save, ensureGuild, _markEntity } from "./core.js";
import { STARBOARD_DEFAULTS, withDefaults } from "./schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// REACTION ROLES, REMINDERS, SCHEDULED TASKS & STARBOARD
// ═══════════════════════════════════════════════════════════════════════════

// ─── Reaction Roles ───────────────────────────────────────────────────────────

export function addReactionRole(guildId, messageId, emoji, roleId, exclusive = true) {
  const s = ensureGuild(guildId);
  if (!s.reaction_roles) s.reaction_roles = {};
  if (!s.reaction_roles[messageId]) s.reaction_roles[messageId] = [];
  // Remove existing entry for this emoji on this message
  s.reaction_roles[messageId] = s.reaction_roles[messageId].filter((r) => r.emoji !== emoji);
  s.reaction_roles[messageId].push({ emoji, roleId, exclusive });
  save("guild_settings");
}

export function isReactionRoleExclusive(guildId, messageId) {
  const roles = data.guild_settings[guildId]?.reaction_roles?.[messageId];
  // Default to true — existing roles without the flag are treated as exclusive
  return roles?.[0]?.exclusive ?? true;
}

export function removeReactionRole(guildId, messageId, emoji) {
  const s = data.guild_settings[guildId];
  if (!s?.reaction_roles?.[messageId]) return;
  s.reaction_roles[messageId] = s.reaction_roles[messageId].filter((r) => r.emoji !== emoji);
  if (s.reaction_roles[messageId].length === 0) delete s.reaction_roles[messageId];
  _markEntity("guild_settings", guildId);
  save("guild_settings");
}

export function getReactionRoles(guildId, messageId) {
  return data.guild_settings[guildId]?.reaction_roles?.[messageId] ?? [];
}

export function getAllReactionRoles(guildId) {
  return data.guild_settings[guildId]?.reaction_roles ?? {};
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export function addReminder(userId, guildId, channelId, message, fireAt) {
  if (!data.reminders) data.reminders = [];
  const reminder = {
    id: data._nextReminderId++,
    userId,
    guildId,
    channelId,
    message,
    fireAt: typeof fireAt === "number" ? fireAt : fireAt.getTime(),
  };
  data.reminders.push(reminder);
  save("reminders");
  return reminder;
}

export function getReminders() {
  return data.reminders ?? [];
}

export function removeReminder(id) {
  if (!data.reminders) return;
  data.reminders = data.reminders.filter((r) => r.id !== id);
  save("reminders");
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────
// Deferred tool calls queued via the schedule_task AI tool.

export function addScheduledTask(guildId, channelId, authorId, toolName, toolInput, fireAt, note) {
  if (!data.scheduled_tasks) data.scheduled_tasks = [];
  const task = {
    id: data._nextScheduledTaskId++,
    guildId,
    channelId,
    authorId,
    toolName,
    toolInput,
    fireAt: typeof fireAt === "number" ? fireAt : fireAt.getTime(),
    note: note ?? null,
    createdAt: Date.now(),
  };
  data.scheduled_tasks.push(task);
  save("scheduled_tasks");
  return task;
}

export function getScheduledTasks(guildId) {
  const all = data.scheduled_tasks ?? [];
  return guildId ? all.filter((t) => t.guildId === guildId) : all;
}

export function getScheduledTask(id) {
  return (data.scheduled_tasks ?? []).find((t) => t.id === id) ?? null;
}

export function removeScheduledTask(id) {
  if (!data.scheduled_tasks) return { changes: 0 };
  const before = data.scheduled_tasks.length;
  data.scheduled_tasks = data.scheduled_tasks.filter((t) => t.id !== id);
  save("scheduled_tasks");
  return { changes: before - data.scheduled_tasks.length };
}

// ─── Starboard ────────────────────────────────────────────────────────────────

export function setStarboard(guildId, channelId, threshold) {
  const s = ensureGuild(guildId);
  s.starboard_channel = channelId;
  s.starboard_threshold = threshold ?? 3;
  save("guild_settings");
}

export function getStarboard(guildId) {
  // Project stored snake_case fields into the slice shape, then merge.
  // Only project keys that are set so unset ones inherit STARBOARD_DEFAULTS
  // (channelId: null, threshold: 3). Explicit-null channel id is preserved
  // (an admin clearing the starboard channel keeps the threshold).
  const s = data.guild_settings[guildId];
  const stored = {};
  if (s?.starboard_channel !== undefined) stored.channelId = s.starboard_channel;
  if (s?.starboard_threshold !== undefined) stored.threshold = s.starboard_threshold;
  return withDefaults(STARBOARD_DEFAULTS, stored);
}

export function addStarboardEntry(guildId, messageId, starboardMessageId) {
  if (!data.starboard_entries) data.starboard_entries = {};
  if (!data.starboard_entries[guildId]) data.starboard_entries[guildId] = {};
  data.starboard_entries[guildId][messageId] = starboardMessageId;
  _markEntity("starboard_entries", guildId);
  save("starboard_entries");
}

export function getStarboardEntry(guildId, messageId) {
  return data.starboard_entries?.[guildId]?.[messageId] ?? null;
}
