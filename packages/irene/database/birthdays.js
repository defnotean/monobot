/**
 * @file packages/irene/database/birthdays.js
 * @module irene/database/birthdays
 *
 * Birthday roster (top-level data.birthdays slice), birthday channel/role/
 * message config (in guild_settings), and the per-year "already announced"
 * dedupe map (data.birthday_announced).
 */

import { data, save, ensureGuild } from "./core.js";
import { log } from "../utils/logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// BIRTHDAYS — birthday roster + per-guild channel/role/message config
// ═══════════════════════════════════════════════════════════════════════════

// ─── Birthdays ─────────────────────────────────────────────────────────────────

export function setBirthday(userId, guildId, month, day, year) {
  if (!data.birthdays) data.birthdays = [];
  data.birthdays = data.birthdays.filter((b) => !(b.userId === userId && b.guildId === guildId));
  const entry = { userId, guildId, month, day };
  if (year) entry.year = year;
  data.birthdays.push(entry);
  save("birthdays");
}

export function removeBirthday(userId, guildId) {
  if (!data.birthdays) return false;
  const before = data.birthdays.length;
  data.birthdays = data.birthdays.filter((b) => !(b.userId === userId && b.guildId === guildId));
  if (data.birthdays.length !== before) { save("birthdays"); return true; }
  return false;
}

export function getBirthday(userId, guildId) {
  return (data.birthdays ?? []).find((b) => b.userId === userId && b.guildId === guildId) ?? null;
}

export function getGuildBirthdays(guildId) {
  return (data.birthdays ?? []).filter((b) => b.guildId === guildId);
}

export function getTodaysBirthdays(guildId) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return (data.birthdays ?? []).filter((b) => b.guildId === guildId && b.month === month && b.day === day);
}

export function setBirthdayChannel(guildId, channelId) {
  ensureGuild(guildId).birthday_channel_id = channelId;
  save("guild_settings");
}

export function setBirthdayRole(guildId, roleId) {
  ensureGuild(guildId).birthday_role_id = roleId;
  save("guild_settings");
}

export function setBirthdayMessage(guildId, message) {
  const s = ensureGuild(guildId);
  if (message) s.birthday_message = message;
  else delete s.birthday_message;
  save("guild_settings");
}

export function getBirthdayConfig(guildId) {
  const s = data.guild_settings[guildId];
  return {
    channel_id: s?.birthday_channel_id ?? null,
    role_id: s?.birthday_role_id ?? null,
    message: s?.birthday_message ?? "🎂 Happy Birthday {user}! Wishing you an amazing day — you deserve it! 🎉",
  };
}

export function markBirthdayAnnounced(userId, guildId) {
  const currentYear = new Date().getFullYear();
  const key = `${guildId}-${userId}-${currentYear}`;
  if (!data.birthday_announced) data.birthday_announced = {};
  data.birthday_announced[key] = true;

  // Prune entries from previous years to prevent unbounded growth
  let pruned = 0;
  for (const k of Object.keys(data.birthday_announced)) {
    const yearMatch = k.match(/-(\d{4})$/);
    if (yearMatch && parseInt(yearMatch[1]) < currentYear) {
      delete data.birthday_announced[k];
      pruned++;
    }
  }
  if (pruned > 0) log(`[DB] Pruned ${pruned} old birthday-announced entries`);

  save("birthday_announced");
}

export function wasBirthdayAnnounced(userId, guildId) {
  const key = `${guildId}-${userId}-${new Date().getFullYear()}`;
  return data.birthday_announced?.[key] === true;
}
