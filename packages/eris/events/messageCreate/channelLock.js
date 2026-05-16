// ─── packages/eris/events/messageCreate/channelLock.js ──────────────────────
// Per-channel mutex used by the orchestrator to serialize concurrent messages
// in the same Discord channel. Pulled out of messageCreate.js so the lock is
// owned by a single module rather than the god-function file.

const channelLocks = new Map();

export async function withLock(key, fn) {
  const prev = channelLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(r => (release = r));
  channelLocks.set(key, current);
  await prev;
  try { return await fn(); }
  finally {
    release();
    // If this channel's current promise is ours, clean it up
    if (channelLocks.get(key) === current) channelLocks.delete(key);
  }
}
