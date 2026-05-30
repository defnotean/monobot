/**
 * @file packages/irene/database/emotional.js
 * @module irene/database/emotional
 *
 * Emotional state shared with the Eris sibling bot: global mood/energy and
 * per-user relationship affinity. Both are top-level cache slices that fan out
 * to their own per-entity rows. updateRelationshipLocked routes through the
 * per-user mutex from ./core.js.
 */

import { data, save, withUserLock } from "./core.js";
import { MOOD_DEFAULTS, RELATIONSHIP_DEFAULTS, withDefaults } from "./schemas.js";
import { normalizeRelationship, shiftRelationship, shiftMoodWithInertia } from "@defnotean/shared/innerState";

// ═══════════════════════════════════════════════════════════════════════════
// EMOTIONAL STATE — global mood/energy + per-user relationship affinity
// ═══════════════════════════════════════════════════════════════════════════

// ─── Mood & Energy (shared emotional state) ──────────────────────────────────

export function getMood() {
  // Merge defaults so a partial/missing in-memory row still yields the
  // full MOOD_DEFAULTS shape (mood_score: 0, energy: 50).
  return withDefaults(MOOD_DEFAULTS, data.mood);
}

export function updateMood(score, energy) {
  data.mood.mood_score = Math.max(-100, Math.min(100, score));
  data.mood.energy = Math.max(0, Math.min(100, energy));
  save("mood");
}

export function shiftMood(delta, energyDelta = 0) {
  const next = shiftMoodWithInertia(data.mood, delta, energyDelta);
  updateMood(next.mood_score, next.energy);
}

export function moodLabel(score) {
  if (score >= 60) return "ecstatic";
  if (score >= 30) return "happy";
  if (score >= 10) return "chill";
  if (score >= -10) return "neutral";
  if (score >= -30) return "annoyed";
  if (score >= -60) return "pissed";
  return "furious";
}

// ─── Relationships (per-user affinity tracking) ──────────────────────────────

export function getRelationship(userId) {
  // Merge defaults so a missing/partial row still yields the full
  // RELATIONSHIP_DEFAULTS shape (affinity_score: 0, interactions_count: 0).
  return normalizeRelationship(withDefaults(RELATIONSHIP_DEFAULTS, data.relationships[userId]));
}

// Synchronous read-modify-write. Safe to call directly when no `await` sits
// between a caller's read of the relationship and this mutation — JS is
// single-threaded so a purely-sync RMW can't interleave. Use
// updateRelationshipLocked when the caller's sequence spans an await.
export function updateRelationship(userId, affinityDelta, options = {}) {
  const current = getRelationship(userId);
  data.relationships[userId] = shiftRelationship(current, affinityDelta, options);
  save("relationships");
}

// Lock-serialised affinity bump. Routes the read-modify-write through the
// per-user mutex so two concurrent interactions adjusting the SAME user's
// affinity can't both read the old score and clobber each other's increment —
// the documented atomicity guarantee for "affinity bumps". Returns the new
// relationship row. Prefer this over updateRelationship in async tool/event
// paths that may run concurrently for one user.
export function updateRelationshipLocked(userId, affinityDelta) {
  return withUserLock(`rel:${userId}`, () => {
    updateRelationship(userId, affinityDelta);
    return getRelationship(userId);
  });
}

export function getAllRelationships() {
  return Object.entries(data.relationships).map(([uid, r]) => ({ user_id: uid, ...normalizeRelationship(r) }));
}
