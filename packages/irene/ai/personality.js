// ─── Personality Learning System ─────────────────────────────────────────────
// Makes bots grow like real people over time. Tracks interaction patterns,
// evolves personality traits, learns catchphrases, adapts to users/servers.

import { log } from "../utils/logger.js";

// ─── In-Memory State ────────────────────────────────────────────────────────

let _data = null; // Loaded from Supabase on first use
// Shared lazy-init promise. Multiple concurrent callers at boot all await the
// same in-flight load instead of each firing their own Supabase query — the
// older `if (_data) return; ... await ...` pattern raced when the first batch
// of messages arrived together, producing duplicate selects and potentially
// inconsistent state when one loader's upsert collided with another's.
let _loadPromise = null;
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

function ensureLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const { default: config } = await import("../config.js");
      const { getSupabase } = await import("../database.js");
      const supabase = getSupabase();
      if (!supabase) { _data = { ...DEFAULTS }; return _data; }

      const botId = config.botName || "irene";
      const { data: row, error } = await supabase.from("irene_personality_learning").select("*").eq("id", botId).single();
      if (error && error.code === "PGRST116") {
        // Table might not exist or no row — try inserting
        await supabase.from("irene_personality_learning").upsert({ id: botId, ...DEFAULTS }).catch(() => {});
        _data = { ...DEFAULTS };
      } else {
        _data = row || { ...DEFAULTS };
      }
      _data._botId = botId;
      log(`[Personality] Loaded for ${botId}: warmth=${_data.traits?.warmth?.toFixed(2)}, sarcasm=${_data.traits?.sarcasm?.toFixed(2)}`);
    } catch (e) {
      log(`[Personality] Load failed: ${e.message}`);
      _data = { ...DEFAULTS };
    }
    return _data;
  })();
  return _loadPromise;
}

function scheduleSave() {
  if (_saveTimer) return;
  _dirty = true;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_dirty || !_data) return;
    try {
      const { getSupabase } = await import("../database.js");
      const supabase = getSupabase();
      if (!supabase) return;
      const botId = _data._botId || "irene";
      await supabase.from("irene_personality_learning").upsert({
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
      log(`[Personality] Save failed: ${e.message}`);
    }
  }, 10_000); // Save every 10 seconds at most
}

// Accessor for sibling modules (ai/opinions.js) that need to read/write the
// personality data without re-implementing loading.
export async function _getData() {
  return ensureLoaded();
}

// Let sibling modules mark the data dirty and trigger a debounced save.
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
    const botId = _data._botId || "irene";
    await supabase.from("irene_personality_learning").upsert({
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

  // Natural decay toward baseline (0) — very slow
  for (const trait of Object.keys(data.traits)) {
    const val = data.traits[trait];
    if (Math.abs(val) > 0.01) {
      data.traits[trait] -= val * 0.005; // 0.5% decay per drift
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
