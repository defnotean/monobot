// ─── Opinions / Self-Consistency ────────────────────────────────────────────
// The bot forms opinions over time. A real person holds their stance — or
// acknowledges when they've changed their mind. This module is what keeps her
// from saying "i love X" today and "i hate X" tomorrow without noticing.
//
// Storage: reuses the existing `opinions` array in the personality_learning
// Supabase row (declared in DEFAULTS there, previously unwired).
//
// Public surface:
//   recordOpinion({ topic, stance, reason, strength })  - called by tool or auto-extract
//   findRelatedOpinions(message, limit)                 - keyword overlap match
//   buildOpinionContext(message)                        - prompt fragment for the LLM
//   listRecentOpinions(limit)                           - for recall_my_take tool
//
// All calls are async because they touch the shared personality data via
// ai/personality.js _getData().

import { log } from "../utils/logger.js";

// ─── Tunables ───────────────────────────────────────────────────────────────

const MAX_OPINIONS = 60;              // Cap to keep the row small
const DEDUPE_OVERLAP_THRESHOLD = 0.7;  // Topic-text overlap to treat as the same topic
const MIN_TOPIC_LEN = 3;               // Ignore 1-2 char topic keywords
const STOPWORDS = new Set([
  "the","a","an","and","or","but","so","is","are","was","were","be","been","being",
  "do","does","did","have","has","had","i","you","he","she","it","we","they","me",
  "my","your","his","her","our","their","this","that","these","those","what","why",
  "how","when","where","who","which","to","of","in","on","at","for","with","as",
  "by","from","about","into","over","under","than","then","just","not","no","yes",
  "can","could","will","would","should","may","might","must","lol","lmao","ngl",
  "tbh","imo","rn","ur","u","wtf","bruh","idk","fr","like","really","very","some",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= MIN_TOPIC_LEN && !STOPWORDS.has(w));
}

function overlapRatio(aWords, bWords) {
  if (!aWords.size || !bWords.size) return 0;
  let hits = 0;
  for (const w of aWords) if (bWords.has(w)) hits++;
  return hits / Math.max(aWords.size, bWords.size);
}

function normalizeStance(stance) {
  const s = String(stance || "").toLowerCase().trim();
  if (["positive", "pro", "love", "+", "yes", "good", "like"].includes(s)) return "positive";
  if (["negative", "anti", "hate", "-", "no", "bad", "dislike"].includes(s)) return "negative";
  if (["neutral", "mixed", "meh", "idk"].includes(s)) return "neutral";
  return s || "neutral";
}

function describeAge(ms) {
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a new opinion. If an existing opinion covers the same topic, it's
 * updated instead of duplicated — and if the stance flipped, the previous
 * stance is preserved in `previousStance` so the bot can acknowledge growth.
 */
export async function recordOpinion({ topic, stance, reason = null, strength = 0.5 } = {}) {
  if (!topic || !stance) return { ok: false, error: "topic and stance required" };
  const { _getData } = await import("./personality.js");
  const data = await _getData();
  if (!data) return { ok: false, error: "personality data unavailable" };
  if (!Array.isArray(data.opinions)) data.opinions = [];

  const normStance = normalizeStance(stance);
  const newTopicWords = new Set(tokenize(topic));
  if (!newTopicWords.size) return { ok: false, error: "topic is empty after normalization" };

  // Dedupe against existing opinions by topic-word overlap.
  let existingIdx = -1;
  for (let i = 0; i < data.opinions.length; i++) {
    const existing = data.opinions[i];
    const existWords = new Set(tokenize(existing.topic));
    if (overlapRatio(newTopicWords, existWords) >= DEDUPE_OVERLAP_THRESHOLD) {
      existingIdx = i;
      break;
    }
  }

  const now = new Date().toISOString();
  if (existingIdx >= 0) {
    const prev = data.opinions[existingIdx];
    const flipped = prev.stance !== normStance;
    data.opinions[existingIdx] = {
      ...prev,
      topic: prev.topic, // keep the original topic phrasing
      stance: normStance,
      reason: reason ?? prev.reason,
      strength: Math.max(0, Math.min(1, Number(strength) || 0)),
      previousStance: flipped ? prev.stance : prev.previousStance ?? null,
      flippedAt: flipped ? now : prev.flippedAt ?? null,
      updatedAt: now,
    };
  } else {
    data.opinions.unshift({
      topic: String(topic).slice(0, 120),
      stance: normStance,
      reason: reason ? String(reason).slice(0, 200) : null,
      strength: Math.max(0, Math.min(1, Number(strength) || 0)),
      previousStance: null,
      flippedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (data.opinions.length > MAX_OPINIONS) data.opinions.length = MAX_OPINIONS;
  }

  // Trigger save via the personality module (it handles debouncing).
  try {
    const p = await import("./personality.js");
    p._markOpinionsDirty?.();
  } catch (e) {
    log(`[Opinions] Save trigger failed: ${e.message}`);
  }

  return { ok: true, flipped: existingIdx >= 0 && data.opinions[existingIdx].flippedAt === now };
}

/**
 * Find opinions whose topic keywords overlap with the given message. Returns
 * an array sorted most relevant first, capped at `limit`.
 */
export async function findRelatedOpinions(message, limit = 3) {
  const { _getData } = await import("./personality.js");
  const data = await _getData();
  const opinions = Array.isArray(data?.opinions) ? data.opinions : [];
  if (!opinions.length) return [];

  const msgWords = new Set(tokenize(message));
  if (!msgWords.size) return [];

  const scored = [];
  for (const op of opinions) {
    const topicWords = new Set(tokenize(op.topic));
    const ratio = overlapRatio(msgWords, topicWords);
    // Require at least one shared topic word AND meaningful overlap.
    if (ratio >= 0.25 && topicWords.size > 0) {
      scored.push({ op, score: ratio });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.op);
}

const STALE_OPINION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Build a prompt fragment so the LLM remains self-consistent — or
 * explicitly acknowledges having changed its mind. If any matched opinion
 * is older than STALE_OPINION_MS, adds a small "still feel this way?"
 * reflection hint so she can genuinely grow rather than stay frozen on
 * an old stance.
 */
export async function buildOpinionContext(message, opts = {}) {
  const related = await findRelatedOpinions(message, opts.limit ?? 2);
  if (!related.length) return "";

  const now = Date.now();
  let anyStale = false;

  const lines = related.map(op => {
    // Defensive parse — malformed timestamps used to produce NaN ages, which
    // silently disabled stale-opinion detection (NaN > X is always false).
    const parsedUpdated = op.updatedAt ? Date.parse(op.updatedAt) : NaN;
    const updatedAt = Number.isFinite(parsedUpdated) ? parsedUpdated : now;
    const ageMs = now - updatedAt;
    const ago = op.updatedAt && Number.isFinite(parsedUpdated) ? describeAge(ageMs) : "a while back";
    const reason = op.reason ? ` because ${op.reason}` : "";
    if (ageMs > STALE_OPINION_MS) anyStale = true;
    if (op.flippedAt && op.previousStance) {
      const parsedFlip = Date.parse(op.flippedAt);
      const flipAge = Number.isFinite(parsedFlip) ? describeAge(now - parsedFlip) : "recently";
      return `  - "${op.topic}": you used to be ${op.previousStance}, changed to ${op.stance} ${flipAge}${reason}`;
    }
    return `  - "${op.topic}": you're ${op.stance}${reason} (${ago})`;
  }).join("\n");

  const growthHint = anyStale
    ? "\n-- one of these stances is over a month old. don't blindly parrot it. if you'd actually feel differently now, say so naturally (\"ngl i think i've come around on this\") and use save_my_take to update it. real growth looks like that."
    : "";

  return `[YOUR PRIOR TAKES ON THIS:\n${lines}\n-- stay consistent with these unless you'd genuinely change your mind. if your view here differs from what you said before, own it: "ngl i used to think the opposite" or similar. never silently contradict yourself.${growthHint}]`;
}

/**
 * Return recent opinions for the recall_my_take tool, optionally filtered
 * to a specific topic match.
 */
export async function listRecentOpinions({ topic = null, limit = 10 } = {}) {
  const { _getData } = await import("./personality.js");
  const data = await _getData();
  const opinions = Array.isArray(data?.opinions) ? [...data.opinions] : [];
  if (topic) {
    const topicWords = new Set(tokenize(topic));
    return opinions
      .filter(op => overlapRatio(topicWords, new Set(tokenize(op.topic))) >= 0.25)
      .slice(0, limit);
  }
  return opinions.slice(0, limit);
}

// ─── Testing helpers ────────────────────────────────────────────────────────
export const _internal = { tokenize, overlapRatio, normalizeStance };
