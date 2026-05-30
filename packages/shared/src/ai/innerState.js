/**
 * @typedef {{ mood_score?: number, energy?: number }} MoodLike
 * @typedef {{
 *   affinity_score?: number,
 *   interactions_count?: number,
 *   trust_score?: number,
 *   familiarity_score?: number,
 *   playfulness_score?: number,
 *   irritation_score?: number,
 *   respect_score?: number,
 *   fact?: string,
 *   fact_text?: string,
 *   importance?: string,
 *   created_at?: string,
 *   addedAt?: string,
 * }} RelationshipLike
 * @typedef {{ sentiment?: number, dampen?: boolean, trustDelta?: number, isOwner?: boolean, playful?: boolean }} RelationshipShiftOptions
 * @typedef {{ immediate?: boolean }} MoodShiftOptions
 */

const REL_DEFAULTS = Object.freeze({
  affinity_score: 0,
  interactions_count: 0,
  trust_score: 0,
  familiarity_score: 0,
  playfulness_score: 0,
  irritation_score: 0,
  respect_score: 0,
});

/** @type {Readonly<Record<string, number>>} */
const IMPORTANCE_WEIGHT = Object.freeze({
  trivial: 0,
  normal: 1,
  important: 2,
  core: 3,
});

/** @param {unknown} value @param {number} fallback */
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** @param {unknown} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, numberOr(value, min)));
}

/** @param {RelationshipLike} [relationship] */
export function normalizeRelationship(relationship = {}) {
  return {
    affinity_score: clamp(numberOr(relationship.affinity_score, 0), -100, 100),
    interactions_count: Math.max(0, Math.floor(numberOr(relationship.interactions_count, 0))),
    trust_score: clamp(numberOr(relationship.trust_score, 0), 0, 100),
    familiarity_score: clamp(numberOr(relationship.familiarity_score, 0), 0, 100),
    playfulness_score: clamp(numberOr(relationship.playfulness_score, 0), 0, 100),
    irritation_score: clamp(numberOr(relationship.irritation_score, 0), 0, 100),
    respect_score: clamp(numberOr(relationship.respect_score, 0), 0, 100),
  };
}

/** @param {RelationshipLike} [relationship] @param {number} [affinityDelta] @param {RelationshipShiftOptions} [options] */
export function shiftRelationship(relationship = {}, affinityDelta = 0, options = {}) {
  const current = normalizeRelationship(relationship);
  const sentiment = clamp(options.sentiment ?? (affinityDelta / 10), -1, 1);
  const positive = Math.max(0, sentiment);
  const negative = Math.max(0, -sentiment);
  const deltaCap = options.dampen ? 12 : 100;
  const delta = clamp(affinityDelta, -deltaCap, deltaCap);

  return {
    affinity_score: clamp(current.affinity_score + delta, -100, 100),
    interactions_count: current.interactions_count + 1,
    trust_score: clamp(current.trust_score + positive * 4 - negative * 5 + (options.trustDelta || 0), 0, 100),
    familiarity_score: clamp(current.familiarity_score + 1 + (options.isOwner ? 1 : 0), 0, 100),
    playfulness_score: clamp(current.playfulness_score + positive * 3 - negative + (options.playful ? 4 : 0), 0, 100),
    irritation_score: clamp(current.irritation_score + negative * 6 - positive * 3, 0, 100),
    respect_score: clamp(current.respect_score + positive * 2 - negative * 2 + (options.isOwner ? 2 : 0), 0, 100),
  };
}

/** @param {MoodLike} [mood] @param {number} [delta] @param {number} [energyDelta] @param {MoodShiftOptions} [options] */
export function shiftMoodWithInertia(mood = {}, delta = 0, energyDelta = 0, options = {}) {
  const score = clamp(mood.mood_score, -100, 100);
  const energy = clamp(mood.energy, 0, 100);
  const rawDelta = numberOr(delta, 0);
  const cap = options.immediate ? 100 : 10;
  const easedDelta = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), cap, Math.ceil(Math.sqrt(Math.abs(rawDelta)) * 2));
  const baselineDrift = rawDelta === 0 ? (score > 0 ? -1 : score < 0 ? 1 : 0) : 0;

  return {
    mood_score: clamp(score + easedDelta + baselineDrift, -100, 100),
    energy: clamp(energy + numberOr(energyDelta, 0), 0, 100),
  };
}

/** @param {number} score */
export function moodToneLabel(score) {
  const s = clamp(score, -100, 100);
  if (s >= 60) return "bright";
  if (s >= 30) return "good";
  if (s >= 10) return "decent";
  if (s >= -10) return "neutral";
  if (s >= -30) return "a little off";
  if (s >= -60) return "irritated";
  return "rough";
}

/** @param {{ mood?: MoodLike, relationship?: RelationshipLike, speakerName?: string }} [state] */
export function buildInnerStateContext({ mood, relationship, speakerName = "this person" } = {}) {
  const m = shiftMoodWithInertia(mood, 0, 0, { immediate: true });
  const rel = normalizeRelationship(relationship);
  const energy = m.energy >= 70 ? "high" : m.energy >= 35 ? "normal" : "low";
  const bond = rel.familiarity_score >= 70 ? "familiar" : rel.interactions_count >= 20 ? "known" : rel.interactions_count > 0 ? "new-ish" : "new";

  return `[PRIVATE STATE — do not mention directly: mood ${moodToneLabel(m.mood_score)}, energy ${energy}. Relationship with ${speakerName}: ${bond}; affinity ${rel.affinity_score}, trust ${Math.round(rel.trust_score)}, playfulness ${Math.round(rel.playfulness_score)}, irritation ${Math.round(rel.irritation_score)}, respect ${Math.round(rel.respect_score)}. Use this only as subtle tone: warmth means easier banter, irritation means slightly shorter/sharper, low energy means concise. React proportionally; no melodrama, love-bombing, cruelty, or claims of real senses/hidden experiences. If memory is uncertain, hedge casually instead of inventing.]`;
}

/** @param {string} [importance] */
export function normalizeMemoryImportance(importance = "normal") {
  const value = String(importance || "normal").toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMPORTANCE_WEIGHT, value) ? value : "normal";
}

/** @param {unknown} fact @param {string} [explicitImportance] */
export function rankMemoryFact(fact, explicitImportance = "normal") {
  const text = String(fact || "").trim();
  const lower = text.toLowerCase();
  let importance = normalizeMemoryImportance(explicitImportance);
  let confidence = 0.72;

  if (/\b(my name is|call me|i am|i'm|pronouns?|birthday|born|diagnosed|allergic|do not|don't mention|never mention)\b/.test(lower)) {
    importance = IMPORTANCE_WEIGHT[importance] < 3 ? "core" : importance;
    confidence = 0.88;
  } else if (/\b(love|hate|favorite|favourite|prefer|likes?|dislikes?|working on|goal|family|partner|school|job|timezone|language)\b/.test(lower)) {
    importance = IMPORTANCE_WEIGHT[importance] < 2 ? "important" : importance;
    confidence = 0.8;
  } else if (/\b(today|right now|rn|currently|temporary|for now|this week|tonight)\b/.test(lower)) {
    importance = IMPORTANCE_WEIGHT[importance] > 1 ? importance : "trivial";
    confidence = 0.62;
  }

  return {
    importance,
    confidence,
    weight: IMPORTANCE_WEIGHT[importance],
  };
}

/** @param {RelationshipLike | string} item */
function memoryText(item) {
  if (item && typeof item === "object") return item.fact_text || item.fact || "";
  return item;
}

/** @param {RelationshipLike | string} item */
function memoryImportance(item) {
  return item && typeof item === "object" ? item.importance : undefined;
}

/** @param {RelationshipLike | string} item */
function memoryTime(item) {
  return item && typeof item === "object" ? (item.created_at || item.addedAt || "") : "";
}

/** @param {RelationshipLike | string} a @param {RelationshipLike | string} b */
export function compareMemoryPriority(a, b) {
  const aw = rankMemoryFact(memoryText(a), memoryImportance(a)).weight;
  const bw = rankMemoryFact(memoryText(b), memoryImportance(b)).weight;
  if (aw !== bw) return aw - bw;
  const at = Date.parse(memoryTime(a)) || 0;
  const bt = Date.parse(memoryTime(b)) || 0;
  return at - bt;
}
