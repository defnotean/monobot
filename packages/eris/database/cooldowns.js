/**
 * @file packages/eris/database/cooldowns.js
 * @module packages/eris/database/cooldowns
 *
 * Generic per-tool cooldowns, rapid-action activity streaks, and the work
 * career-tier ladder. All pure in-memory Maps — no Supabase, no core import.
 * The `_cooldowns` and `_careerTiers` maps are also swept by the economy
 * module's periodic eviction loop (it imports them from here), so they live in
 * this leaf module to keep the import graph acyclic.
 */

const _cooldowns = new Map(); // "userId:toolName" → timestamp
const _activityStreaks = new Map(); // "userId:activity" → { count, lastTimestamp }
const _careerTiers = new Map(); // userId → { count, tier }

// Internal handles shared with the economy eviction sweep. Not part of the
// public database surface — the barrel does not re-export these.
export { _cooldowns, _careerTiers };

// ─── ACTIVITY STREAKS ────────────────────────────────────────────────────────

export function getActivityStreak(userId, activity) {
  const key = `${userId}:${activity}`;
  const data = _activityStreaks.get(key);
  if (!data) return { count: 0, bonus: 0 };
  // Streak expires if more than 2 minutes past the cooldown window
  const elapsed = Date.now() - data.lastTimestamp;
  if (elapsed > 120_000) {
    _activityStreaks.delete(key);
    return { count: 0, bonus: 0 };
  }
  const bonus = data.count >= 10 ? 0.50 : data.count >= 5 ? 0.25 : data.count >= 3 ? 0.10 : 0;
  return { count: data.count, bonus };
}

export function incrementActivityStreak(userId, activity) {
  const key = `${userId}:${activity}`;
  const existing = _activityStreaks.get(key);
  const elapsed = existing ? Date.now() - existing.lastTimestamp : Infinity;
  // Continue streak if within grace window, otherwise reset
  const count = elapsed <= 120_000 ? (existing.count + 1) : 1;
  _activityStreaks.set(key, { count, lastTimestamp: Date.now() });
  return count;
}

// ─── CAREER TIERS (Work) ────────────────────────────────────────────────────

export function getCareerTier(userId) {
  const data = _careerTiers.get(userId);
  if (!data) return { count: 0, tier: 1, bonus: 0 };
  const tier = Math.min(5, 1 + Math.floor(data.count / 10));
  const bonus = (tier - 1) * 50; // T1: +0, T2: +50, T3: +100, T4: +150, T5: +200
  return { count: data.count, tier, bonus };
}

export function incrementCareerCount(userId) {
  const existing = _careerTiers.get(userId) || { count: 0 };
  existing.count++;
  _careerTiers.set(userId, existing);
  return getCareerTier(userId);
}

/**
 * @returns {{ onCooldown: true, remainingMs: number, remainingSec: number } | { onCooldown: false }}
 */
export function checkCooldown(userId, toolName, cooldownMs) {
  const key = `${userId}:${toolName}`;
  const last = _cooldowns.get(key) || 0;
  const remaining = cooldownMs - (Date.now() - last);
  if (remaining > 0) return { onCooldown: true, remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) };
  return { onCooldown: false };
}

export function setCooldown(userId, toolName) {
  _cooldowns.set(`${userId}:${toolName}`, Date.now());
}

/**
 * Atomic cooldown acquire — single-step read-check-set. Use this instead of
 * the check/set pair to close the race where two parallel calls both read
 * the old timestamp, both see "not on cooldown", and both pass through.
 * Returns the same shape as checkCooldown so it drops in as a replacement.
 *
 * @returns {{ onCooldown: true, remainingMs: number, remainingSec: number } | { onCooldown: false }}
 */
export function tryAcquireCooldown(userId, toolName, cooldownMs) {
  const key = `${userId}:${toolName}`;
  const last = _cooldowns.get(key) || 0;
  const now = Date.now();
  const remaining = cooldownMs - (now - last);
  if (remaining > 0) return { onCooldown: true, remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) };
  _cooldowns.set(key, now);
  return { onCooldown: false };
}
