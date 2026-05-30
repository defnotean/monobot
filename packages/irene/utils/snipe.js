// ─── Snipe & Edit-Snipe Cache ───────────────────────────────────────────────
// Stores deleted messages AND pre-edit versions for sniping.
// Multi-message cache: stores last 10 per channel (not just 1).
// 30-minute expiry (not 5 minutes).

const _deleteCache = new Map();  // channelId → [{ content, author, authorId, avatar, attachments, stickers, embeds, deletedAt }]
const _editCache = new Map();    // channelId → [{ before, after, author, authorId, avatar, editedAt, messageUrl }]

const MAX_PER_CHANNEL = 10;
const EXPIRY_MS = 30 * 60_000; // 30 minutes

// Periodic cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ch, entries] of _deleteCache) {
    const fresh = entries.filter(e => now - e.deletedAt < EXPIRY_MS);
    if (fresh.length) _deleteCache.set(ch, fresh);
    else _deleteCache.delete(ch);
  }
  for (const [ch, entries] of _editCache) {
    const fresh = entries.filter(e => now - e.editedAt < EXPIRY_MS);
    if (fresh.length) _editCache.set(ch, fresh);
    else _editCache.delete(ch);
  }
}, 600_000);

/** Cache a deleted message for snipe retrieval */
export function cacheDeletedMessage(message) {
  if (message.author?.bot) return;
  if (!message.content && !message.attachments?.size && !message.stickers?.size) return; // Empty

  const channelId = message.channel?.id;
  if (!channelId) return;

  if (!_deleteCache.has(channelId)) _deleteCache.set(channelId, []);
  const cache = _deleteCache.get(channelId);

  cache.push({
    content: message.content || "",
    author: message.author?.globalName || message.author?.tag || message.author?.username || "Unknown",
    authorId: message.author?.id,
    avatar: message.author?.displayAvatarURL?.({ size: 64 }) || null,
    attachments: [...(message.attachments?.values() || [])].map(a => ({ url: a.url, name: a.name, size: a.size })),
    stickers: [...(message.stickers?.values() || [])].map(s => s.name),
    embedCount: message.embeds?.length || 0,
    replyTo: message.reference?.messageId || null,
    deletedAt: Date.now(),
  });

  // Keep only last N
  while (cache.length > MAX_PER_CHANNEL) cache.shift();
}

/** Cache a message edit (before version) for edit-snipe */
export function cacheEditedMessage(oldMessage, newMessage) {
  if (newMessage.author?.bot) return;
  if (oldMessage.partial) return; // Can't snipe if we don't have the old content
  if (oldMessage.content === newMessage.content) return; // No actual text change

  const channelId = newMessage.channel?.id;
  if (!channelId) return;

  if (!_editCache.has(channelId)) _editCache.set(channelId, []);
  const cache = _editCache.get(channelId);

  cache.push({
    before: oldMessage.content || "(empty)",
    after: newMessage.content || "(empty)",
    author: newMessage.author?.globalName || newMessage.author?.tag || newMessage.author?.username || "Unknown",
    authorId: newMessage.author?.id,
    avatar: newMessage.author?.displayAvatarURL?.({ size: 64 }) || null,
    messageUrl: newMessage.url,
    editedAt: Date.now(),
  });

  while (cache.length > MAX_PER_CHANNEL) cache.shift();
}

/**
 * Get sniped (deleted) messages for a channel.
 * @param {string} channelId
 * @param {number} [index=0] - 0 = most recent, 1 = second most recent, etc.
 * @returns {object|null}
 */
export function getSnipedMessage(channelId, index = 0) {
  const cache = _deleteCache.get(channelId);
  if (!cache?.length) return null;

  // Filter expired
  const now = Date.now();
  const fresh = cache.filter(e => now - e.deletedAt < EXPIRY_MS);
  if (!fresh.length) { _deleteCache.delete(channelId); return null; }
  _deleteCache.set(channelId, fresh);

  // Return from most recent (end of array)
  const idx = fresh.length - 1 - Math.min(index, fresh.length - 1);
  return fresh[idx] || null;
}

/**
 * Get edit-sniped messages for a channel.
 * @param {string} channelId
 * @param {number} [index=0]
 * @returns {object|null}
 */
export function getEditSnipe(channelId, index = 0) {
  const cache = _editCache.get(channelId);
  if (!cache?.length) return null;

  const now = Date.now();
  const fresh = cache.filter(e => now - e.editedAt < EXPIRY_MS);
  if (!fresh.length) { _editCache.delete(channelId); return null; }
  _editCache.set(channelId, fresh);

  const idx = fresh.length - 1 - Math.min(index, fresh.length - 1);
  return fresh[idx] || null;
}

/** Get count of available snipes in a channel */
export function getSnipeCount(channelId) {
  const now = Date.now();
  const deletes = (_deleteCache.get(channelId) || []).filter(e => now - e.deletedAt < EXPIRY_MS).length;
  const edits = (_editCache.get(channelId) || []).filter(e => now - e.editedAt < EXPIRY_MS).length;
  return { deletes, edits };
}
