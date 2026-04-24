// ─── Message Evidence Buffer ────────────────────────────────────────────────
// Rolling in-memory per-user buffer of the last N messages they sent in each
// guild. When a mod (or Irene's AI moderation) bans or kicks a user, the ban
// embed pulls from this buffer so the mod-log includes the *context* for the
// action: what the user actually said before getting banned.
//
// Intentionally NOT persisted. Buffer is ephemeral by design — on bot restart
// it starts empty. This keeps the evidence window tight (only captures while
// the bot is up) and means we never write user chat content to disk/Supabase.
//
// Shape:
//   global LRUCache<`${guildId}:${userId}`, Message[]>
//
// Bucket max: 10 messages per user per guild (MAX_MESSAGES_PER_USER).
// User-bucket max: 1000 (guildId,userId) pairs total across all guilds
// (MAX_USER_BUCKETS) — LRU eviction prevents unbounded growth on churny servers.
//
// Messages are stored as compact records, not raw discord.js Message objects
// (those reference the client, channel, etc. and would hold a lot of memory).

import { LRUCache } from "@defnotean/shared/LRUCache";

const MAX_MESSAGES_PER_USER = 10;
const MAX_USER_BUCKETS = 1000;
// Entries auto-expire after 24h even without eviction — an hour-old message
// is rarely useful evidence and this protects against long-term memory bloat
// on low-churn servers.
const TTL_MS = 24 * 60 * 60 * 1000;

const buckets = new LRUCache(MAX_USER_BUCKETS, TTL_MS);

function makeKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * Record a message for evidence buffering.
 * Called from events/messageCreate.js on every guild message.
 * Silently no-ops on non-guild messages or bot messages.
 */
export function recordMessage(message) {
  if (!message?.guildId) return;
  if (!message?.author?.id) return;
  if (message.author.bot) return; // Don't buffer bot messages (including our own)

  const key = makeKey(message.guildId, message.author.id);
  const existing = buckets.get(key) || [];

  const record = {
    channelId: message.channelId,
    channelName: message.channel?.name ?? "unknown-channel",
    content: String(message.content ?? "").slice(0, 500), // cap per-message length
    attachmentCount: message.attachments?.size ?? 0,
    stickerCount: message.stickers?.size ?? 0,
    timestamp: message.createdTimestamp ?? Date.now(),
    messageId: message.id,
  };

  existing.push(record);
  // Keep only the most recent MAX_MESSAGES_PER_USER
  if (existing.length > MAX_MESSAGES_PER_USER) {
    existing.splice(0, existing.length - MAX_MESSAGES_PER_USER);
  }

  buckets.set(key, existing);
}

/**
 * Retrieve the evidence buffer for a user in a guild.
 * Returns an array of compact message records, most recent LAST.
 * Returns [] if no messages buffered (or bot was restarted recently).
 */
export function getEvidence(guildId, userId) {
  if (!guildId || !userId) return [];
  return buckets.get(makeKey(guildId, userId)) || [];
}

/**
 * Format evidence as a Discord-embed-friendly string.
 * Returns an empty string if no evidence captured.
 * Caller decides whether to include a "no messages captured" placeholder.
 */
export function formatEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return "";

  const lines = evidence.map((r) => {
    const time = `<t:${Math.floor(r.timestamp / 1000)}:R>`;
    const chan = r.channelName ? `#${r.channelName}` : `<#${r.channelId}>`;
    const body = r.content || "(no text)";
    const extras = [];
    if (r.attachmentCount) extras.push(`📎 ×${r.attachmentCount}`);
    if (r.stickerCount) extras.push(`🧸 ×${r.stickerCount}`);
    const tail = extras.length ? ` ${extras.join(" ")}` : "";
    return `${time} ${chan}: ${body}${tail}`;
  });

  return lines.join("\n");
}

/**
 * Clear a specific user's buffer in a guild. Intended for testing.
 */
export function clearEvidence(guildId, userId) {
  if (!guildId || !userId) return;
  buckets.delete(makeKey(guildId, userId));
}

/**
 * Size of the evidence buffer (number of tracked user-guild pairs).
 * Exposed for observability in startup logs.
 */
export function evidenceBufferSize() {
  return buckets.size;
}

/** Internal — exported for tests only. */
export const __internals = {
  MAX_MESSAGES_PER_USER,
  MAX_USER_BUCKETS,
  TTL_MS,
  _buckets: buckets,
};
