const cooldowns = new Map();

export function checkCooldown(key, userId, durationMs) {
  const k = `${key}:${userId}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(k);
  if (expiresAt && now < expiresAt) {
    return { onCooldown: true, remaining: Math.ceil((expiresAt - now) / 1000) };
  }
  cooldowns.set(k, now + durationMs);
  return { onCooldown: false };
}

// Cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cooldowns) {
    if (now >= v) cooldowns.delete(k);
  }
}, 300_000);
