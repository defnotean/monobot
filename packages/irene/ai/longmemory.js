// ─── Long-Term Conversational Memory ─────────────────────────────────────────
// Three memory systems working together:
// 1. EPISODIC — story-level memories (arguments, bits, bonding moments)
// 2. NARRATIVE — mood anchoring with reasons ("still annoyed about X")
// 3. MONOLOGUE — inner thought scratchpad that persists across messages
//
// 4. SEMANTIC — vector-based similarity search via Voyage AI + pgvector
//
// These bridge the gap between the 10-message sliding window and permanent facts.

import { log } from "../utils/logger.js";

// ─── In-Memory Stores ───────────────────────────────────────────────────────

const _episodes = new Map();      // userId → [{type, content, participants, at}]
const _channelEpisodes = new Map(); // channelId → [{type, content, at}]
const _moodNarratives = new Map();  // channelId/userId → mood narrative (per-context, not global)
let _monologue = [];               // her inner thoughts (last 5)
let _dirty = false;
let _saveTimer = null;
let _lastConsolidation = 0;        // timestamp of last episodic consolidation

// ─── Episode Types ──────────────────────────────────────────────────────────

const EPISODE = {
  RUNNING_BIT: "running_bit",         // recurring joke between her and someone
  UNRESOLVED_TENSION: "tension",      // argument that wasn't resolved
  FUNNY_MOMENT: "funny",             // something that got laughs
  VENTING_SESSION: "venting",        // someone venting to her
  BONDING_MOMENT: "bond",            // trust/vulnerability/warmth
  SHARED_OPINION: "opinion",         // strong opinion she expressed
  CALLBACK: "callback",             // she referenced something from the past
};

// ─── 1. Mood Narrative (WHY she feels this way) ─────────────────────────────

/**
 * Update the mood reason — called when mood shifts significantly.
 * Instead of just "mood: -40", she knows "still annoyed about the
 * argument about server rules earlier"
 */
export function updateMoodNarrative(reason, contextKey = "global") {
  _moodNarratives.set(contextKey, reason);
  if (_moodNarratives.size > 50) {
    const oldest = _moodNarratives.keys().next().value;
    _moodNarratives.delete(oldest);
  }
  scheduleSave();
}

/**
 * Auto-detect mood narrative from conversation context.
 */
export function inferMoodNarrative(userMessage, botResponse, sentiment, userId) {
  if (Math.abs(sentiment) < 0.3) return;
  const key = userId || "global";

  if (sentiment < -0.5) {
    _moodNarratives.set(key, `irritated — someone was being negative. "${userMessage.substring(0, 50)}"`);
  } else if (sentiment < -0.3) {
    _moodNarratives.set(key, `a little off — the vibe was weird just now`);
  } else if (sentiment > 0.5) {
    _moodNarratives.set(key, `feeling good — had a nice interaction just now`);
  } else if (sentiment > 0.3) {
    _moodNarratives.set(key, `decent mood — people are being chill`);
  }
  scheduleSave();
}

export function getMoodNarrative(contextKey = "global") {
  return _moodNarratives.get(contextKey) || _moodNarratives.get("global") || "";
}

// ─── 2. Inner Monologue Scratchpad ──────────────────────────────────────────

/**
 * Add an inner thought. These are her private thoughts that persist
 * across the sliding window. Only she sees them in the system prompt.
 *
 * The AI generates these as part of tool results or we extract them
 * from her responses (things she was thinking about).
 */
export function addThought(thought) {
  if (!thought || thought.length < 5) return;
  if (_monologue.length > 0) {
    const last = _monologue[_monologue.length - 1].thought.toLowerCase();
    if (thought.toLowerCase().includes(last.substring(0, 30)) || last.includes(thought.toLowerCase().substring(0, 30))) return;
  }
  _monologue.push({
    thought: thought.substring(0, 200),
    at: Date.now(),
  });
  if (_monologue.length > 15) _monologue.shift();
  scheduleSave();
}

export function extractThoughts(botResponse) {
  if (!botResponse) return;
  const lower = botResponse.toLowerCase();
  if (/\b(random thought|i was thinking|i just realized|you know what|now that i think|i wonder|hmm actually)\b/i.test(lower)) {
    addThought(botResponse.substring(0, 120));
  }
  if (/\b(curious about|wanna know more|that's interesting|i should look into)\b/i.test(lower)) {
    addThought(`curious about: ${botResponse.match(/\b(?:curious about|wanna know more about|interested in)\s+([^.!?\n]+)/i)?.[1] || botResponse.substring(0, 50)}`);
  }
}

let _lastThoughtGen = 0;
export async function generateInnerThought(userMessage, botResponse, username, geminiClient, botName = "Irene") {
  if (!geminiClient || !userMessage || !botResponse) return;
  if (Date.now() - _lastThoughtGen < 60_000) return;
  if (Math.random() > 0.4) return;
  _lastThoughtGen = Date.now();
  try {
    const response = await Promise.race([
      geminiClient.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ parts: [{ text: `You are ${botName}'s subconscious. She just had this exchange:\nUser (${username}): "${userMessage.substring(0, 100)}"\n${botName}: "${botResponse.substring(0, 100)}"\n\nWrite ONE brief inner thought she'd have after this (max 15 words). Write in third person like a narrator: "${botName} wondered..." or "${botName} felt..." or "${botName} made a mental note..."\nExamples:\n- "${botName} wondered if they actually meant that"\n- "${botName} made a mental note to check on them later"\n- "${botName} felt a little proud of that comeback"\n- "${botName} noticed they seemed off today"\nDo NOT use quotes. Just the thought.` }] }],
        config: { maxOutputTokens: 40 },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);
    const thought = response.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
    if (thought && thought.length > 10 && thought.length < 200) addThought(thought);
  } catch {}
}

export function getMonologue() {
  return _monologue.filter(t => Date.now() - t.at < 21600_000); // 6 hours
}

export function getEpisodes() { return _episodes; }
export function getChannelEpisodes() { return _channelEpisodes; }

// ─── 3. Episodic Memory (Story-Level) ───────────────────────────────────────

/**
 * Record an episode — a meaningful story-level event.
 */
export function recordEpisode(userId, channelId, episode) {
  if (!episode.type || !episode.content) return;

  episode.at = Date.now();
  episode.userId = userId;

  // Per-user
  if (!_episodes.has(userId)) _episodes.set(userId, []);
  const userEps = _episodes.get(userId);
  userEps.push(episode);
  if (userEps.length > 15) userEps.shift();

  // Per-channel
  if (channelId) {
    if (!_channelEpisodes.has(channelId)) _channelEpisodes.set(channelId, []);
    const chEps = _channelEpisodes.get(channelId);
    chEps.push(episode);
    if (chEps.length > 10) chEps.shift();
  }

  scheduleSave();
}

/**
 * Analyze a conversation exchange and extract episodes.
 * Called after each bot response.
 */
export async function analyzeExchange(userId, channelId, userMessage, botResponse, sentiment) {
  if (!userMessage || !botResponse) return;
  const userLower = userMessage.toLowerCase();
  const botLower = botResponse.toLowerCase();

  // ── Running bit detection ─────────────────────────────────────────
  // Check if the bot or user repeated a phrase from a previous exchange
  const userEps = _episodes.get(userId) || [];
  for (const ep of userEps) {
    if (ep.type === EPISODE.RUNNING_BIT && ep.phrase) {
      if (userLower.includes(ep.phrase) || botLower.includes(ep.phrase)) {
        ep.count = (ep.count || 1) + 1;
        ep.lastUsed = Date.now();
        scheduleSave();
        return; // Already tracked this bit
      }
    }
  }

  // ── Argument/tension ──────────────────────────────────────────────
  if (sentiment < -0.4 || /\b(no that's wrong|disagree|nah that's|you're wrong|bad take)\b/i.test(botLower)) {
    recordEpisode(userId, channelId, {
      type: EPISODE.UNRESOLVED_TENSION,
      content: `argued about: "${userMessage.substring(0, 80)}" — she said: "${botResponse.substring(0, 80)}"`,
    });
    inferMoodNarrative(userMessage, botResponse, sentiment, userId);
  }

  // ── Venting/emotional support ─────────────────────────────────────
  if (/\b(i'm so (tired|stressed|sad|frustrated|done|over it)|having a bad|rough day|can't deal)\b/i.test(userLower)) {
    recordEpisode(userId, channelId, {
      type: EPISODE.VENTING_SESSION,
      content: `user was venting: "${userMessage.substring(0, 80)}"`,
    });
  }

  // ── Bonding ───────────────────────────────────────────────────────
  if (sentiment > 0.5 || /\b(thank you|you're the best|appreciate you|means a lot|ily|love you)\b/i.test(userLower)) {
    recordEpisode(userId, channelId, {
      type: EPISODE.BONDING_MOMENT,
      content: `bonded: "${userMessage.substring(0, 60)}" → "${botResponse.substring(0, 60)}"`,
    });
    inferMoodNarrative(userMessage, botResponse, sentiment, userId);
  }

  // ── Opinion she shared ────────────────────────────────────────────
  if (/\b(i think|honestly|imo|ngl|tbh|hot take|unpopular opinion)\b/i.test(botLower)) {
    recordEpisode(userId, channelId, {
      type: EPISODE.SHARED_OPINION,
      content: `shared opinion: "${botResponse.substring(0, 100)}"`,
    });
  }

  // ── Funny moment (short + positive = probably humor) ──────────────
  if (botResponse.length < 80 && sentiment > 0.2 && /\b(lol|lmao|haha|💀|😭)\b/i.test(botLower)) {
    // Potential running bit if repeated
    const key = botResponse.toLowerCase().replace(/[^a-z ]/g, "").trim().substring(0, 30);
    if (key.length > 5) {
      recordEpisode(userId, channelId, {
        type: EPISODE.RUNNING_BIT,
        phrase: key,
        content: botResponse.substring(0, 60),
        count: 1,
        lastUsed: Date.now(),
      });
    }
  }

  // Extract inner monologue from her response
  extractThoughts(botResponse);

  // Store significant episodes with vector embeddings for semantic search
  try {
    const { storeEpisode } = await import("./semantic.js");
    const { default: cfg } = await import("../config.js");
    const botId = cfg.botName || "irene";

    // Only embed significant episodes (not every message)
    if (sentiment < -0.4 || sentiment > 0.5 ||
        /\b(running bit|inside joke|argued|bonded|venting|opinion)\b/i.test(botResponse) ||
        /\b(i think|honestly|imo|ngl|tbh)\b/i.test(botLower)) {
      const summary = `user said: "${userMessage.substring(0, 100)}" — bot replied: "${botResponse.substring(0, 100)}"`;
      const type = sentiment < -0.3 ? "tension" : sentiment > 0.3 ? "bond" : "exchange";
      storeEpisode(botId, userId, channelId, null, type, summary)
        .catch((err) => log(`[LongMemory] storeEpisode failed: ${err.message}`));
    }
  } catch (err) {
    log(`[LongMemory] analyzeExchange outer error: ${err.message}`);
  }
}

// ─── Build Context for System Prompt ────────────────────────────────────────

/**
 * Returns long-term context to inject into the system prompt.
 * This is what bridges the gap between the sliding window and permanent memory.
 */
export async function buildLongTermContext(userId, channelId, currentMessage = "") {
  const parts = [];

  // ── Mood narrative (per-user, falls back to global) ────────────
  const narrative = getMoodNarrative(userId) || getMoodNarrative("global");
  if (narrative) {
    parts.push(`[MOOD REASON: ${narrative}]`);
  }

  // ── Inner monologue ───────────────────────────────────────────────
  const thoughts = getMonologue();
  if (thoughts.length) {
    parts.push(`[RECENT THOUGHTS: ${thoughts.map(t => `"${t.thought}"`).join(", ")}]`);
  }

  // ── Goals & Reflections (from consciousness loop) ────────────────
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase?.() || null;
    if (sb) {
      const { data: row } = await sb.from("bot_data").select("data").eq("id", "irene_consciousness").single();
      if (row?.data) {
        const goals = row.data.goals;
        const refs = row.data.reflections;
        const allGoals = [...(goals?.short || []), ...(goals?.medium || []), ...(goals?.long || [])];
        if (allGoals.length) parts.push(`[YOUR CURRENT ASPIRATIONS: ${allGoals.slice(0, 3).join("; ")}]`);
        if (refs?.length) parts.push(`[SELF-REFLECTION: ${refs.slice(-2).map(r => `"${r.text}"`).join(", ")}]`);
      }
    }
  } catch {}

  // ── Episodes with this user ───────────────────────────────────────
  const userEps = _episodes.get(userId) || [];
  const recentEps = userEps
    .filter(e => Date.now() - e.at < 7 * 86400_000) // Last 7 days
    .slice(-5);

  if (recentEps.length) {
    const epSummaries = recentEps.map(e => {
      const hours = Math.floor((Date.now() - e.at) / 3600_000);
      const timeAgo = hours < 1 ? "just now" : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
      return `(${timeAgo}) ${e.content}`;
    });
    parts.push(`[HISTORY WITH THIS PERSON: ${epSummaries.join(" | ")}]`);
  }

  // ── Running bits ──────────────────────────────────────────────────
  const bits = userEps.filter(e => e.type === EPISODE.RUNNING_BIT && (e.count || 0) >= 2);
  if (bits.length) {
    parts.push(`[RUNNING BITS: ${bits.map(b => `"${b.phrase || b.content}" (${b.count}x)`).join(", ")}]`);
  }

  // ── Channel energy ────────────────────────────────────────────────
  const chEps = _channelEpisodes.get(channelId) || [];
  const recentCh = chEps.filter(e => Date.now() - e.at < 3600_000);
  if (recentCh.length > 1) {
    const tensions = recentCh.filter(e => e.type === EPISODE.UNRESOLVED_TENSION).length;
    const bonds = recentCh.filter(e => e.type === EPISODE.BONDING_MOMENT).length;
    if (tensions > bonds) parts.push("[CHANNEL ENERGY: tense vibes recently. tread carefully or address it]");
    else if (bonds > 1) parts.push("[CHANNEL ENERGY: warm vibes. match the energy]");
  }

  // ── Semantic memory search (vector similarity) ─────────────────────
  if (currentMessage) {
    try {
      const { searchRelevantMemories } = await import("./semantic.js");
      const { default: cfg } = await import("../config.js");
      const botId = cfg.botName || "irene";
      const relevant = await searchRelevantMemories(botId, userId, currentMessage, 3);
      if (relevant.length) {
        const memories = relevant
          .filter(r => r.similarity > 0.35)
          .map(r => `"${r.content}"`)
          .slice(0, 3);
        if (memories.length) {
          parts.push(`[RELEVANT MEMORIES: ${memories.join(" | ")}]`);
        }
      }
    } catch {}
  }

  return parts.join("\n");
}

// ─── Persistence ────────────────────────────────────────────────────────────

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_dirty) return;
    try {
      const { getSupabase } = await import("../database.js");
      const supabase = getSupabase();
      if (!supabase) return;

      const episodes = {};
      for (const [k, v] of _episodes) episodes[k] = v.slice(-10);
      const channels = {};
      for (const [k, v] of _channelEpisodes) channels[k] = v.slice(-8);

      try {
        await supabase.from("bot_data").upsert({
          id: "irene_long_memory",
          data: {
            episodes,
            channels,
            moodNarratives: Object.fromEntries(_moodNarratives),
            monologue: _monologue,
          },
        });
      } catch {}

      _dirty = false;
    } catch (e) {
      log(`[LongMemory] Save failed: ${e.message}`);
    }
  }, 30_000);
}

/** Flush dirty long-term memory immediately — call on SIGINT/SIGTERM. */
export async function flush() {
  if (!_dirty) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;
    const episodes = {};
    for (const [k, v] of _episodes) episodes[k] = v.slice(-10);
    const channels = {};
    for (const [k, v] of _channelEpisodes) channels[k] = v.slice(-8);
    await supabase.from("bot_data").upsert({
      id: "irene_long_memory",
      data: { episodes, channels, moodNarratives: Object.fromEntries(_moodNarratives), monologue: _monologue },
    });
    _dirty = false;
  } catch (e) {
    log(`[LongMemory] Flush failed: ${e.message}`);
  }
}

export async function loadLongMemory() {
  try {
    const { getSupabase } = await import("../database.js");
    const supabase = getSupabase();
    if (!supabase) return;

    const { data: row } = await supabase.from("bot_data").select("data").eq("id", "irene_long_memory").single();
    if (row?.data) {
      if (row.data.episodes) for (const [k, v] of Object.entries(row.data.episodes)) _episodes.set(k, v);
      if (row.data.channels) for (const [k, v] of Object.entries(row.data.channels)) _channelEpisodes.set(k, v);
      if (row.data.moodNarratives) {
        for (const [k, v] of Object.entries(row.data.moodNarratives)) _moodNarratives.set(k, v);
      } else if (row.data.moodNarrative) {
        _moodNarratives.set("global", row.data.moodNarrative);
      }
      if (row.data.monologue) _monologue = row.data.monologue;
      log(`[LongMemory] Loaded: ${_episodes.size} users, ${_channelEpisodes.size} channels, monologue: ${_monologue.length}`);
    }
  } catch (e) {
    log(`[LongMemory] Load failed: ${e.message}`);
  }
}
