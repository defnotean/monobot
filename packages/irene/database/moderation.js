/**
 * @file packages/irene/database/moderation.js
 * @module irene/database/moderation
 *
 * Moderation warnings — add/get/delete/clear. Backed by the top-level
 * data.warnings slice with a monotonic data._nextWarningId.
 */

import { data, save } from "./core.js";

export function addWarning(guildId, userId, moderatorId, reason) {
  const warning = {
    id: data._nextWarningId++,
    guild_id: guildId,
    user_id: userId,
    moderator_id: moderatorId,
    reason,
    created_at: new Date().toISOString(),
  };
  data.warnings.push(warning);
  save("warnings");
  return warning;
}

export function getWarnings(guildId, userId) {
  return data.warnings
    .filter((w) => w.guild_id === guildId && w.user_id === userId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function deleteWarning(id, guildId) {
  const idx = data.warnings.findIndex((w) => w.id === id && w.guild_id === guildId);
  if (idx !== -1) {
    data.warnings.splice(idx, 1);
    save("warnings");
    return { changes: 1 };
  }
  return { changes: 0 };
}

export function clearWarnings(guildId, userId) {
  const before = data.warnings.length;
  data.warnings = data.warnings.filter((w) => !(w.guild_id === guildId && w.user_id === userId));
  save("warnings");
  return { changes: before - data.warnings.length };
}
