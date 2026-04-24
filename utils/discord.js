// ─── Shared Discord helpers ──────────────────────────────────────────────────
// Small utilities used across event handlers and executors.

import { log } from "./logger.js";

/**
 * Safely fetch a channel, returning null instead of throwing.
 * Replaces the repeated `client.channels.fetch(id).catch(() => null)` pattern.
 */
export async function getChannelSafe(client, channelId) {
  if (!channelId) return null;
  try {
    return client.channels.cache.get(channelId)
      ?? await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

/**
 * Channels that must never be picked as a fallback target for random events.
 * Matches name substrings (case-insensitive).
 */
const EVENT_EXCLUDE_PATTERNS = /\b(log|logs|admin|mod|modlog|audit|announce|announcement|report|ticket|staff|error|alert|welcome|rules|verify|faq|info)\b/i;

/**
 * Preferred channel names for auto-fallback when no channel is configured.
 * Ordered by preference — earlier matches win.
 */
const EVENT_PREFER_ORDER = [
  /\b(events?|casino|gambling|economy)\b/i,
  /\b(general|chat|lounge|commons)\b/i,
  /\b(bot|command|spam)\b/i,
];

/**
 * Resolve the target channel (and optional ping roles) for a feature's
 * server-initiated messages (random events, announcements, etc.).
 *
 * Honors admin configuration from `db.getFeatureConfig(guildId, feature)`:
 *   - `enabled: false` → returns null channel (feature off)
 *   - `channel_id` set → uses that channel if bot can send there
 *   - otherwise → smart name-based fallback that *excludes* admin/log/mod
 *     channels (previous code name-matched anything containing "bot", which
 *     fired events into #bot-commands and #bot-logs)
 *
 * Returns `{ channel, pingRoleIds, pingPrefix }` — caller prepends `pingPrefix`
 * to message content for role pings. `channel` is null if no valid target.
 */
export function getFeatureChannel(guild, db, feature) {
  const empty = { channel: null, pingRoleIds: [], pingPrefix: "" };
  if (!guild || !db?.getFeatureConfig || !feature) return empty;

  const cfg = db.getFeatureConfig(guild.id, feature);
  if (cfg?.enabled === false) return empty;

  const pingRoleIds = Array.isArray(cfg?.ping_role_ids) ? cfg.ping_role_ids : [];
  const pingPrefix = pingRoleIds.length
    ? pingRoleIds.map(id => `<@&${id}>`).join(" ") + " "
    : "";

  const me = guild.members?.me;
  const canSendIn = (c) =>
    c?.isTextBased?.() && !c.isVoiceBased?.() &&
    (!me || c.permissionsFor(me)?.has("SendMessages"));

  // Configured channel wins — if it's valid.
  if (cfg?.channel_id) {
    const configured = guild.channels.cache.get(cfg.channel_id);
    if (configured && canSendIn(configured)) {
      return { channel: configured, pingRoleIds, pingPrefix };
    }
    // Configured channel is invalid — fall through to auto-pick so the
    // feature keeps working instead of silently going dark.
  }

  // Fallback: auto-pick, excluding admin/log/announcement channels.
  const candidates = [...guild.channels.cache.values()]
    .filter(c => canSendIn(c) && !EVENT_EXCLUDE_PATTERNS.test(c.name || ""));

  for (const pattern of EVENT_PREFER_ORDER) {
    const match = candidates.find(c => pattern.test(c.name || ""));
    if (match) return { channel: match, pingRoleIds, pingPrefix };
  }

  // Last resort: any sendable non-excluded text channel.
  return { channel: candidates[0] || null, pingRoleIds, pingPrefix };
}

/**
 * Resolve a user-supplied target string to a GuildMember.
 * Handles mentions (<@123>, <@!123>), raw IDs, usernames, and display names.
 * Returns null if no match found.
 *
 * Replaces the broken pattern where `guild.members.fetch({ query })` was
 * called with a numeric ID (Discord's query searches by name, not ID).
 */
export async function resolveMember(guild, raw) {
  if (!guild || !raw) return null;
  const cleaned = String(raw).replace(/[<@!>]/g, "").trim();
  if (!cleaned) return null;

  // Snowflake IDs are 17-20 digits — try direct fetch first
  if (/^\d{17,20}$/.test(cleaned)) {
    try {
      return await guild.members.fetch(cleaned);
    } catch { /* fall through to name search */ }
  }

  try {
    const members = await guild.members.fetch({ query: cleaned, limit: 5 });
    const lower = cleaned.toLowerCase();
    return members.find(m =>
      m.user.username.toLowerCase() === lower ||
      m.displayName.toLowerCase() === lower
    ) || null;
  } catch {
    return null;
  }
}

/**
 * Record a game result + pay out winnings/losses in one call.
 * Replaces 10+ identical blocks in interactionCreate.js button handlers.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.gameType   e.g. "coinflip", "blackjack", "slots"
 * @param {boolean} opts.won
 * @param {number} opts.amount     stake amount (positive = winnings, negative = loss)
 * @param {object} db              the database module
 * @returns {Promise<{newBalance: number}>}
 */
export async function recordGameAndPayout(db, { userId, gameType, won, amount }) {
  const delta = won ? amount : -amount;
  const txType = won ? `${gameType}_win` : `${gameType}_loss`;
  await db.updateBalance(userId, delta, txType, `${won ? "won" : "lost"} ${Math.abs(amount)}`);
  const balance = db.getBalance(userId);

  // Unlock achievement on first win/loss if the function exists
  if (won && db.unlockAchievement) {
    db.unlockAchievement(userId, `${gameType}_winner`).catch(() => {});
  }

  db.recordGameResult?.(userId, gameType, won, Math.abs(amount));
  return { newBalance: balance };
}
