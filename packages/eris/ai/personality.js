/**
 * @file packages/eris/ai/personality.js
 * @module eris/ai/personality
 *
 * Eris's personality, voice, and mood model — the long-lived state that makes
 * her feel like a continuous character across restarts instead of a stateless
 * chat completion. This module owns the slow-moving "who Eris is right now"
 * data; the static base prompt template lives elsewhere (see
 * `packages/eris/prompts/`) and is composed at request time by
 * `executor.js`, which calls `buildPersonalityContext()` from this file and
 * concatenates its output into the system prompt.
 *
 * What gets loaded:
 *   - `traits`         — five-axis personality vector (warmth, sarcasm, chaos,
 *                        helpfulness, energy), each clamped to [-1, 1].
 *   - `mood_history`   — rolling 30-day window of per-day average sentiment,
 *                        used as the anchor that drift slowly pulls toward.
 *   - `opinions`       — durable stances Eris has formed (topic + reason +
 *                        timestamp); read/written here, but populated mostly
 *                        by sibling module `ai/opinions.js` via the
 *                        `_getData()` / `_markOpinionsDirty()` accessors.
 *   - `catchphrases`   — phrases that earned positive reactions; the top 20
 *                        get fed back into the prompt as voice anchors.
 *   - `user_styles`    — per-user adaptation (avg message length, emoji
 *                        density, recurring topics).
 *   - `server_vibes`   — per-guild aggregate sentiment + recurring topics.
 *   - `lessons_learned` and `self_facts` — written by other modules,
 *                        round-tripped here so the persistence schema stays
 *                        in one place.
 *
 * Lazy-load pattern:
 *   This module uses the older single-flag `if (_data) return _data` guard
 *   inside an async `ensureLoaded()`. It is NOT race-safe under concurrent
 *   boot-time callers — Irene's sibling module switched to a shared
 *   `_loadPromise` pattern after observing duplicate Supabase selects and
 *   colliding upserts during cold start. Eris has not been migrated yet;
 *   if you start seeing duplicate `[Personality] Loaded for eris` log lines,
 *   port Irene's pattern here.
 *
 * Mood / drift model:
 *   Every `DRIFT_INTERVAL` (100) interactions, `driftPersonality()` nudges
 *   each trait by small deltas (0.003–0.01) based on the recent sentiment
 *   buffer and help-request ratio, then applies a 0.1% pull toward the
 *   baseline of 0 — but only for traits already past |0.3|. The asymmetry
 *   is intentional: positive sentiment moves warmth up faster than it moves
 *   it down, so genuine warmth sticks; chaos is reinforced by high-variance
 *   days. The slow decay (10x slower than Irene's) means Eris's drifted
 *   personality is anchored more firmly than her twin's.
 *
 * Opinion persistence:
 *   Opinions live in the same Supabase row as traits (`eris_personality_learning`).
 *   Sibling modules mutate `_data.opinions` directly through `_getData()` and
 *   call `_markOpinionsDirty()` to trigger the debounced save instead of
 *   re-implementing the load/save plumbing. All persistence flows through
 *   the 10-second debounced `scheduleSave()` or the immediate `flush()` that
 *   should be wired into SIGINT/SIGTERM handlers.
 *
 * Per-turn injection into the system prompt:
 *   `buildPersonalityContext(userId, guildId)` is the only function the
 *   request pipeline needs. It returns a short bracketed-line summary of
 *   anything currently noticeable: drifted traits past |0.05|, the
 *   addressed user's style preferences, the server's vibe, and up to five
 *   high-reaction catchphrases. The caller appends this string to the base
 *   prompt; empty output (no signal yet) returns "" and is harmless to
 *   concatenate.
 *
 * Placeholder substitution:
 *   This module does NOT perform `{{OWNER_ID}}` / `{{TWIN_BOT_ID}}`
 *   substitution. Those tokens live in the static prompt templates loaded
 *   by `packages/eris/prompts/loader.ts`, which resolves them from
 *   `config.js` (env-driven) before the request hits the model. Keep IDs
 *   out of this file — `_getData()` returns user data verbatim, and IDs
 *   stored here would leak into the open-source schema.
 */

import { log } from "../utils/logger.js";

// ─── In-Memory State ────────────────────────────────────────────────────────

let _data = null; // Loaded from Supabase on first use
let _dirty = false;
let _saveTimer = null;
let _interactionBuffer = { count: 0, sentimentSum: 0, helpRequests: 0 };

const DRIFT_INTERVAL = 100; // Drift personality every 100 interactions

// ─── Default Data ───────────────────────────────────────────────────────────

const DEFAULTS = {
  traits: { warmth: 0, sarcasm: 0, chaos: 0, helpfulness: 0, energy: 0 },
  lessons_learned: [],  // things she learned from mistakes: [{lesson, from_user, at}]
  opinions: [],         // opinions formed from experiences: [{topic, stance, reason, at}]
  catchphrases: [],
  server_vibes: {},
  user_styles: {},
  mood_history: [],
  interaction_count: 0,
  last_drift_at: new Date().toISOString(),
};

// ─── Load/Save ──────────────────────────────────────────────────────────────

async function ensureLoaded() {
  if (_data) return _data;
  try {
    const { default: config } = await import("../config.js");
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) { _data = { ...DEFAULTS }; return _data; }

    const botId = config.botName || "eris";
    const { data: row, error } = await supabase.from("eris_personality_learning").select("*").eq("id", botId).single();
    if (error && error.code === "PGRST116") {
      // Table might not exist or no row — try inserting
      await Promise.resolve(supabase.from("eris_personality_learning").upsert({ id: botId, ...DEFAULTS })).catch(() => {});
      _data = { ...DEFAULTS };
    } else {
      _data = row || { ...DEFAULTS };
      // Merge defaults for any missing fields — Supabase row may have nulls
      for (const key of Object.keys(DEFAULTS)) {
        if (_data[key] == null) _data[key] = typeof DEFAULTS[key] === "object" ? (Array.isArray(DEFAULTS[key]) ? [...DEFAULTS[key]] : { ...DEFAULTS[key] }) : DEFAULTS[key];
      }
      // Ensure all trait keys exist
      if (_data.traits && typeof _data.traits === "object") {
        for (const [k, v] of Object.entries(DEFAULTS.traits)) {
          if (_data.traits[k] == null) _data.traits[k] = v;
        }
      }
    }
    _data._botId = botId;
    log(`[Personality] Loaded for ${botId}: warmth=${_data.traits?.warmth?.toFixed(2)}, sarcasm=${_data.traits?.sarcasm?.toFixed(2)}`);
  } catch (e) {
    log(`[Personality] Load failed: ${e.message}`);
    _data = { ...DEFAULTS };
  }
  return _data;
}

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_dirty || !_data) return;
    // Snapshot the dirty flag and clear it BEFORE the upsert so any changes
    // that land during the upsert are tracked as new dirt and will trigger
    // the next save. Previously we set _dirty = false AFTER the await, so a
    // write that happened mid-upsert was wiped along with the pre-upsert
    // state, causing silent data loss for personality drift.
    _dirty = false;
    try {
      const { getSupabase } = await import("../database.js");
      const supabase = getSupabase();
      if (!supabase) { _dirty = true; return; } // DB offline — keep dirty so next cycle retries
      const botId = _data._botId || "eris";
      await supabase.from("eris_personality_learning").upsert({
        id: botId,
        traits: _data.traits,
        catchphrases: _data.catchphrases,
        server_vibes: _data.server_vibes,
        user_styles: _data.user_styles,
        mood_history: _data.mood_history,
        interaction_count: _data.interaction_count,
        last_drift_at: _data.last_drift_at,
        opinions: _data.opinions || [],
        lessons_learned: _data.lessons_learned || [],
        self_facts: _data.self_facts || [],
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      log(`[Personality] Save failed: ${e.message}`);
      _dirty = true; // Keep dirty so next cycle retries
    }
  }, 10_000); // Save every 10 seconds at most
}

// Accessor for sibling modules (ai/opinions.js, ai/preoccupations.js) that
// need to read/write the personality data without re-implementing loading.
export async function _getData() {
  return ensureLoaded();
}

// Let sibling modules mark the data dirty and trigger a debounced save.
// This keeps persistence logic in one place.
export function _markOpinionsDirty() {
  if (!_data) return;
  scheduleSave();
}

/** Flush dirty personality data immediately — call on SIGINT/SIGTERM. */
export async function flush() {
  if (!_dirty || !_data) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;
    const botId = _data._botId || "eris";
    await supabase.from("eris_personality_learning").upsert({
      id: botId,
      traits: _data.traits,
      catchphrases: _data.catchphrases,
      server_vibes: _data.server_vibes,
      user_styles: _data.user_styles,
      mood_history: _data.mood_history,
      interaction_count: _data.interaction_count,
      last_drift_at: _data.last_drift_at,
      opinions: _data.opinions || [],
      lessons_learned: _data.lessons_learned || [],
      self_facts: _data.self_facts || [],
      updated_at: new Date().toISOString(),
    });
    _dirty = false;
  } catch (e) {
    log(`[Personality] Flush failed: ${e.message}`);
  }
}

// ─── Track Interaction ──────────────────────────────────────────────────────

export async function trackInteraction(userId, guildId, message, sentiment) {
  const data = await ensureLoaded();
  if (!data.traits) data.traits = { ...DEFAULTS.traits };

  // Update interaction count
  data.interaction_count = Math.min((data.interaction_count || 0) + 1, 2_147_483_647);

  // Buffer for drift calculation
  _interactionBuffer.count++;
  _interactionBuffer.sentimentSum += sentiment;
  if (/\b(help|how do|can you|please|fix|set up|configure|make)\b/i.test(message)) {
    _interactionBuffer.helpRequests++;
  }

  // ── Track user style ──────────────────────────────────────────────
  if (userId) {
    if (!data.user_styles) data.user_styles = {};
    const style = data.user_styles[userId] || { msg_count: 0, total_length: 0, emoji_count: 0, topics: [] };

    style.msg_count = (style.msg_count || 0) + 1;
    style.total_length = (style.total_length || 0) + message.length;
    style.avg_length = Math.round(style.total_length / style.msg_count);
    style.prefers_short = style.avg_length < 30;

    // Count emojis
    const emojiCount = (message.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
    style.emoji_count = (style.emoji_count || 0) + emojiCount;
    style.prefers_emoji = style.emoji_count / style.msg_count > 0.5;

    // Track topics (simple keyword extraction)
    const topicWords = message.toLowerCase().match(/\b(gaming|valorant|league|code|coding|music|anime|art|meme|school|work|gym|food|movie|stream)\b/g) || [];
    for (const topic of topicWords) {
      if (!style.topics) style.topics = [];
      const existing = style.topics.find(t => t.name === topic);
      if (existing) existing.count++;
      else style.topics.push({ name: topic, count: 1 });
    }
    // Keep top 5 topics
    if (style.topics?.length > 5) {
      style.topics.sort((a, b) => b.count - a.count);
      style.topics = style.topics.slice(0, 5);
    }

    data.user_styles[userId] = style;
  }

  // ── Track server vibe ─────────────────────────────────────────────
  if (guildId) {
    if (!data.server_vibes) data.server_vibes = {};
    const vibe = data.server_vibes[guildId] || { msg_count: 0, sentiment_sum: 0, topics: [] };

    vibe.msg_count = (vibe.msg_count || 0) + 1;
    vibe.sentiment_sum = (vibe.sentiment_sum || 0) + sentiment;
    vibe.avg_sentiment = vibe.sentiment_sum / vibe.msg_count;

    // Server-level topic tracking
    const topicWords = message.toLowerCase().match(/\b(gaming|valorant|league|code|music|anime|art|meme|school|work)\b/g) || [];
    for (const topic of topicWords) {
      if (!vibe.topics) vibe.topics = [];
      const existing = vibe.topics.find(t => t.name === topic);
      if (existing) existing.count++;
      else vibe.topics.push({ name: topic, count: 1 });
    }
    if (vibe.topics?.length > 8) {
      vibe.topics.sort((a, b) => b.count - a.count);
      vibe.topics = vibe.topics.slice(0, 8);
    }

    data.server_vibes[guildId] = vibe;
  }

  // ── Track mood history (daily) ────────────────────────────────────
  const today = new Date().toISOString().split("T")[0];
  if (!data.mood_history) data.mood_history = [];
  let todayEntry = data.mood_history.find(e => e.date === today);
  if (!todayEntry) {
    todayEntry = { date: today, sentiment_sum: 0, count: 0 };
    data.mood_history.push(todayEntry);
    // Keep last 30 days
    if (data.mood_history.length > 30) data.mood_history.shift();
  }
  todayEntry.sentiment_sum += sentiment;
  todayEntry.count++;
  todayEntry.avg = todayEntry.sentiment_sum / todayEntry.count;

  // ── Trigger personality drift every N interactions ─────────────────
  if (_interactionBuffer.count >= DRIFT_INTERVAL) {
    driftPersonality(data);
    _interactionBuffer = { count: 0, sentimentSum: 0, helpRequests: 0 };
  }

  scheduleSave();
}

// ─── Personality Drift ──────────────────────────────────────────────────────

function driftPersonality(data) {
  if (!data.traits) data.traits = { ...DEFAULTS.traits };
  const avgSentiment = _interactionBuffer.sentimentSum / _interactionBuffer.count;
  const helpRatio = _interactionBuffer.helpRequests / _interactionBuffer.count;

  // Tiny shifts based on interaction patterns
  const shift = (trait, delta) => {
    data.traits[trait] = Math.max(-1, Math.min(1, (data.traits[trait] || 0) + delta));
  };

  // Positive interactions → warmer
  if (avgSentiment > 0.2) shift("warmth", 0.01);
  else if (avgSentiment < -0.2) shift("warmth", -0.005);

  // Negative interactions → more sarcastic
  if (avgSentiment < -0.1) shift("sarcasm", 0.008);
  else if (avgSentiment > 0.3) shift("sarcasm", -0.003);

  // Lots of help requests → more helpful
  if (helpRatio > 0.3) shift("helpfulness", 0.01);
  else if (helpRatio < 0.1) shift("helpfulness", -0.003);

  // High variance in sentiment → more chaotic
  const chaosBoost = Math.abs(avgSentiment) > 0.3 ? 0.005 : -0.002;
  shift("chaos", chaosBoost);

  // Natural decay toward baseline (0) — extremely slow so personality actually sticks
  // Only decay traits that haven't been reinforced recently (> 0.3 absolute)
  for (const trait of Object.keys(data.traits)) {
    const val = data.traits[trait];
    if (Math.abs(val) > 0.3) {
      data.traits[trait] -= val * 0.001; // 0.1% decay per drift — 10x slower than before
    }
  }

  data.last_drift_at = new Date().toISOString();

  const changes = Object.entries(data.traits).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");
  log(`[Personality] Drift after ${DRIFT_INTERVAL} interactions: ${changes}`);

  scheduleSave();
}

// ─── Catchphrase Tracking ───────────────────────────────────────────────────

export async function trackCatchphrase(messageContent, reaction) {
  const data = await ensureLoaded();
  if (!data.catchphrases) data.catchphrases = [];
  if (!messageContent || messageContent.length < 5 || messageContent.length > 100) return;

  // Clean the phrase — take the most memorable part
  const phrase = messageContent.toLowerCase().replace(/\n/g, " ").trim();
  if (!phrase) return;

  const existing = data.catchphrases.find(c => c.phrase === phrase);
  if (existing) {
    existing.reactions = (existing.reactions || 0) + 1;
    existing.last_reacted = new Date().toISOString();
  } else {
    data.catchphrases.push({
      phrase,
      reactions: 1,
      first_seen: new Date().toISOString(),
      last_reacted: new Date().toISOString(),
    });
  }

  // Keep top 20 catchphrases by reaction count, expire old ones
  const now = Date.now();
  data.catchphrases = data.catchphrases
    .filter(c => now - new Date(c.last_reacted).getTime() < 30 * 86400_000) // 30 days
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, 20);

  scheduleSave();
}

// ─── Build Personality Context ──────────────────────────────────────────────

export async function buildPersonalityContext(userId, guildId) {
  const data = await ensureLoaded();
  if (!data.traits) return "";

  const parts = [];

  // ── Personality evolution ──────────────────────────────────────────
  const significantTraits = Object.entries(data.traits || {})
    .filter(([, v]) => Math.abs(v) > 0.05) // Only mention noticeable shifts
    .map(([k, v]) => {
      const dir = v > 0 ? "higher" : "lower";
      const desc = {
        warmth: v > 0 ? "you've been warmer and more affectionate lately" : "you've been a bit colder lately",
        sarcasm: v > 0 ? "your sarcasm levels are elevated" : "you've been more sincere than usual",
        chaos: v > 0 ? "your chaotic energy is stronger than normal" : "you've been unusually chill",
        helpfulness: v > 0 ? "you've been extra eager to help" : "you've been more laid back about helping",
        energy: v > 0 ? "your energy is running high" : "you're in a lower-energy phase",
      };
      return desc[k] || `${k} is ${dir}`;
    });

  if (significantTraits.length) {
    parts.push(`[${significantTraits.join(". ")}]`);
  }

  // ── User style adaptation ─────────────────────────────────────────
  if (userId && data.user_styles?.[userId]) {
    const style = data.user_styles[userId];
    const hints = [];
    if (style.prefers_short) hints.push("this person sends short messages, keep yours short too");
    if (style.prefers_emoji) hints.push("they use lots of emojis, feel free to match");
    if (style.topics?.length) {
      const topTopics = style.topics.slice(0, 3).map(t => t.name);
      hints.push(`they're into: ${topTopics.join(", ")}`);
    }
    if (hints.length) parts.push(`[${hints.join(". ")}]`);
  }

  // ── Server vibe ───────────────────────────────────────────────────
  if (guildId && data.server_vibes?.[guildId]) {
    const vibe = data.server_vibes[guildId];
    const hints = [];
    if (vibe.avg_sentiment > 0.2) hints.push("this server has positive and friendly energy");
    else if (vibe.avg_sentiment < -0.1) hints.push("this server has edgy energy — match it");
    if (vibe.topics?.length) {
      const topTopics = vibe.topics.slice(0, 3).map(t => t.name);
      hints.push(`people here talk about ${topTopics.join(", ")} a lot`);
    }
    if (hints.length) parts.push(`[${hints.join(". ")}]`);
  }

  // ── Catchphrases ──────────────────────────────────────────────────
  const goodCatchphrases = (data.catchphrases || [])
    .filter(c => c.reactions >= 3)
    .slice(0, 5)
    .map(c => `"${c.phrase}"`);

  if (goodCatchphrases.length) {
    parts.push(`[you naturally say things like ${goodCatchphrases.join(", ")} — use them when they fit, dont force them]`);
  }

  return parts.join("\n");
}
