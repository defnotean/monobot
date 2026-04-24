// ─── Shared Cooldown Manager ────────────────────────────────────────────────
// Provides per-user, per-command cooldowns with automatic cleanup.

const cooldowns = new Map(); // "command:userId" → expiresAt

const CLEANUP_INTERVAL = 300000; // 5 minutes
let _cleanupTimer = null;

/**
 * Check if a user is on cooldown for a given command.
 * @param {string} commandName - The slash command name
 * @param {string} userId - The user's ID
 * @param {number} durationMs - Cooldown duration in milliseconds
 * @returns {{ onCooldown: boolean, remaining?: number }} - Whether the user is on cooldown and how long until it expires
 */
export function checkCooldown(commandName, userId, durationMs) {
  const key = `${commandName}:${userId}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(key);

  if (expiresAt && now < expiresAt) {
    return { onCooldown: true, remaining: Math.ceil((expiresAt - now) / 1000) };
  }

  cooldowns.set(key, now + durationMs);
  return { onCooldown: false };
}

/**
 * Reset a user's cooldown for a given command.
 * Useful if a command fails and you want to refund the cooldown.
 */
export function resetCooldown(commandName, userId) {
  cooldowns.delete(`${commandName}:${userId}`);
}

/**
 * Start periodic cleanup of expired cooldowns (call once at startup).
 */
export function startCooldownCleanup() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, expiresAt] of cooldowns) {
      if (now >= expiresAt) cooldowns.delete(key);
    }
  }, CLEANUP_INTERVAL);
}
