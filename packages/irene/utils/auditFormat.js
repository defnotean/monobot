// ─── Audit-log formatting helpers ───────────────────────────────────────────
// Pure functions for rendering Discord audit-log entries into compact lines
// for the /audit slash command. Kept separate from the command file so the
// formatting logic is unit-testable without mocking the Discord API.

// Discord audit log action type → human-friendly label.
// See https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events
const ACTION_LABELS = {
  1: "guild update",
  10: "channel create", 11: "channel update", 12: "channel delete",
  13: "channel overwrite create", 14: "channel overwrite update", 15: "channel overwrite delete",
  20: "kick",
  21: "prune",
  22: "ban",
  23: "unban",
  24: "member update",
  25: "member role update",
  26: "member move",
  27: "member disconnect",
  28: "bot add",
  30: "role create", 31: "role update", 32: "role delete",
  40: "invite create", 41: "invite update", 42: "invite delete",
  50: "webhook create", 51: "webhook update", 52: "webhook delete",
  60: "emoji create", 61: "emoji update", 62: "emoji delete",
  72: "message delete", 73: "message bulk delete", 74: "message pin", 75: "message unpin",
  80: "integration create", 81: "integration update", 82: "integration delete",
  83: "stage create", 84: "stage update", 85: "stage delete",
  90: "sticker create", 91: "sticker update", 92: "sticker delete",
  100: "scheduled event create", 101: "scheduled event update", 102: "scheduled event delete",
  110: "thread create", 111: "thread update", 112: "thread delete",
  121: "permissions update",
  140: "automod rule create", 141: "automod rule update", 142: "automod rule delete",
  143: "automod block message",
  150: "automod flag",
  151: "automod timeout",
  // The "moderation" subset that /audit cares about most:
  // 20 (kick), 22 (ban), 23 (unban), 24/25 (member update — covers timeouts).
};

/** Audit log action type IDs that count as "moderation" for filtering /audit user. */
export const MODERATION_ACTION_TYPES = new Set([
  20, // kick
  22, // ban
  23, // unban
  24, // member update (timeout, nickname change)
  25, // member role update
  26, // member move
  27, // member disconnect
]);

export function actionLabel(type) {
  return ACTION_LABELS[type] ?? `action ${type}`;
}

/**
 * Compact one audit entry into a one-line embed-friendly string.
 * Format: `<t:ts:R> · actor → action → target · reason`
 * - ts is in seconds for Discord's timestamp formatter
 * - target shown as mention if id present, else (system)
 * - reason truncated at 80 chars
 *
 * Returns the formatted string. Pure — accepts a normalized entry shape so
 * tests don't need to mock discord.js.
 */
export function formatEntry(entry) {
  const ts = Math.floor((entry.createdTimestamp ?? 0) / 1000);
  const time = ts > 0 ? `<t:${ts}:R>` : "(unknown time)";
  const actorName = entry.executor?.tag ?? entry.executor?.username ?? "unknown actor";
  const actor = `**${actorName}**`;
  const targetName = entry.target?.tag ?? entry.target?.username ?? entry.target?.name;
  const target = targetName ? `\`${targetName}\`` : entry.target?.id ? `<@${entry.target.id}>` : "(no target)";
  const action = actionLabel(entry.action);
  let reason = String(entry.reason ?? "").trim();
  if (!reason) reason = "no reason";
  if (reason.length > 80) reason = reason.slice(0, 77) + "…";
  return `${time} · ${actor} → **${action}** → ${target} · ${reason}`;
}

/**
 * Build a single embed-field-friendly string from a list of entries, capping
 * total length at 1024 chars (Discord embed field limit). Drops oldest entries
 * (the ones at the END of the list per Discord's newest-first ordering — see
 * notes below) until it fits.
 *
 * Returns { value, shown, truncated } where:
 *   value      = the joined string
 *   shown      = how many entries actually appear
 *   truncated  = true if some entries were dropped to fit
 *
 * Note on ordering: Discord's audit-log API returns NEWEST first. Callers can
 * keep that order (default) or reverse it; this helper just truncates from the
 * tail of the input array, so pass entries in your intended display order.
 */
export function joinEntries(entries) {
  const lines = entries.map(formatEntry);
  let shown = lines.length;
  let value = lines.join("\n");
  let truncated = false;
  while (value.length > 1024 && shown > 1) {
    shown--;
    value = lines.slice(0, shown).join("\n");
    truncated = true;
  }
  if (value.length > 1024) {
    // Single line too long — slice it
    value = value.slice(0, 1021) + "…";
  }
  return { value, shown, truncated };
}
