// ─── Humanity Engine ─────────────────────────────────────────────────────────
// Makes the AI feel like a real person: relationship stories, inside jokes,
// unprompted thoughts, mood carry-over, growth, bad days, excitement,
// embarrassment, loyalty, and twin awareness.
//
// All data persists in the personality_learning Supabase row.

import { log } from "../utils/logger.js";

// ─── In-Memory State (persisted periodically via personality save) ────────────

const _relationships = new Map(); // userId → RelationshipData
const _innerState = {
  currentEnergy: 50 + Math.floor(Math.random() * 30), // 50-80 on startup
  lastExcitedAbout: null,
  lastEmbarrassed: null,
  isBadDay: Math.random() < 0.08, // 8% chance of a bad day
  carriedMood: null, // from last conversation
  recentThoughts: [], // unprompted thoughts queue
};

// ─── LLM-as-Judge Cooldown ───────────────────────────────────────────────────
// Per-channel cooldown gate for any LLM-as-judge call that wants to assess
// humanity/sentiment/mood from message content. Without this, a single chatty
// channel can fire a judgment call on every message, blowing cost and tripping
// per-minute rate limits on the provider.
//
// 30 s was picked deliberately: it is long enough that a burst of replies
// from a back-and-forth conversation collapses into one judgment (the typical
// arc of a conversational beat is 5-15 s), short enough that a channel that
// goes quiet for a minute will get a fresh read the next time it lights up.
// Tune downward if cost ceases to be a concern; tune upward if we add more
// LLM-based per-channel work.
const HUMANITY_JUDGE_COOLDOWN_MS = 30_000;
const _channelJudgeLastAt = new Map(); // channelId → epoch ms of last judge call
const _channelJudgeLastResult = new Map(); // channelId → last cached judge result

/**
 * Gate function for any caller wanting to invoke a (potentially expensive)
 * LLM-as-judge humanity assessment for a channel. Returns:
 *   { allow: true, cachedResult: <prev | null> } — caller should run the LLM
 *     call. cachedResult is the last result we saw for this channel (may be
 *     null on first call) — useful if the caller wants to compare/diff.
 *   { allow: false, cachedResult: <prev | null> } — caller MUST skip the LLM
 *     call. If cachedResult is non-null, prefer using it; if null, treat as
 *     "no fresh judgment available" and degrade gracefully.
 */
export function shouldRunHumanityJudge(channelId) {
  if (!channelId) return { allow: true, cachedResult: null };
  const now = Date.now();
  const last = _channelJudgeLastAt.get(channelId) || 0;
  const cachedResult = _channelJudgeLastResult.get(channelId) ?? null;
  if (now - last < HUMANITY_JUDGE_COOLDOWN_MS) {
    return { allow: false, cachedResult };
  }
  _channelJudgeLastAt.set(channelId, now);
  return { allow: true, cachedResult };
}

/**
 * Caller stores the LLM-as-judge result here once it completes so the next
 * cooldown-blocked caller can reuse it instead of degrading to no-data.
 */
export function recordHumanityJudgeResult(channelId, result) {
  if (!channelId) return;
  _channelJudgeLastResult.set(channelId, result);
  // Prune both maps if they get unreasonably large — a long-lived bot in
  // thousands of channels would otherwise leak the Map slowly. We bound at
  // 1024 entries, drop the oldest ~25% in the rare overflow case.
  if (_channelJudgeLastAt.size > 1024) {
    const entries = [..._channelJudgeLastAt.entries()].sort((a, b) => a[1] - b[1]);
    const drop = entries.slice(0, Math.floor(entries.length * 0.25));
    for (const [k] of drop) {
      _channelJudgeLastAt.delete(k);
      _channelJudgeLastResult.delete(k);
    }
  }
}

// ─── Relationship Data Structure ─────────────────────────────────────────────

function getRelationship(userId) {
  if (!_relationships.has(userId)) {
    _relationships.set(userId, {
      stories: [],        // [{moment, when, emotion}] — shared memories with context
      insideJokes: [],    // [{joke, origin, lastReferenced}]
      trustLevel: 0,      // 0-100, earned slowly over consistent positive interactions
      grudge: 0,          // 0-100, decays over time
      lastSeen: null,
      totalInteractions: 0,
      longestStreak: 0,   // consecutive days talking
      currentStreak: 0,
      interests: [],      // topics they talk about
      nickname: null,     // affectionate nickname the bot gave them
    });
  }
  return _relationships.get(userId);
}

// ─── Track Interaction (called every message) ────────────────────────────────

export function trackHumanInteraction(userId, username, message, sentiment, isCreator = false) {
  const rel = getRelationship(userId);
  rel.totalInteractions++;
  rel.lastSeen = Date.now();

  // Creator — always max trust, zero grudge, pure devotion
  if (isCreator) {
    rel.trustLevel = 100;
    rel.grudge = 0;
    // Mood boost handled in messageCreate.js
  } else {
    // Trust builds slowly — positive interactions add 0.3-1, negative subtract 1-3
    if (sentiment > 0.2) {
      rel.trustLevel = Math.min(100, rel.trustLevel + (sentiment > 0.5 ? 1 : 0.3));
    } else if (sentiment < -0.3) {
      rel.trustLevel = Math.max(0, rel.trustLevel - 2);
      rel.grudge = Math.min(100, rel.grudge + 10);
    }
  }

  // Grudges decay — 1 point per interaction (forgiveness through presence)
  if (rel.grudge > 0 && !isCreator) rel.grudge = Math.max(0, rel.grudge - 1);

  // Track topics
  const topics = message.toLowerCase().match(/\b(gaming|valorant|league|code|coding|music|anime|art|school|work|gym|food|movie|stream|minecraft|fortnite|apex|overwatch|piano|guitar|drawing|cooking|exam|test|grades)\b/g) || [];
  for (const t of topics) {
    if (!rel.interests.includes(t)) rel.interests.push(t);
    if (rel.interests.length > 10) rel.interests.shift();
  }

  // Streak tracking
  const today = new Date().toDateString();
  if (rel._lastDay !== today) {
    if (rel._lastDay === new Date(Date.now() - 86400000).toDateString()) {
      rel.currentStreak++;
      if (rel.currentStreak > rel.longestStreak) rel.longestStreak = rel.currentStreak;
    } else {
      rel.currentStreak = 1;
    }
    rel._lastDay = today;
  }

  // Mood carry-over — good conversation lifts energy
  if (sentiment > 0.3) {
    _innerState.currentEnergy = Math.min(100, _innerState.currentEnergy + 3);
    _innerState.carriedMood = "good";
  } else if (sentiment < -0.3) {
    _innerState.currentEnergy = Math.max(0, _innerState.currentEnergy - 5);
    _innerState.carriedMood = "drained";
  }
}

// ─── Record a Shared Moment ──────────────────────────────────────────────────

export function recordMoment(userId, moment, emotion = "warm") {
  const rel = getRelationship(userId);
  rel.stories.push({
    moment: moment.substring(0, 200),
    when: Date.now(),
    emotion, // "warm", "funny", "deep", "tense", "protective"
  });
  // Keep last 20 stories per user
  if (rel.stories.length > 20) rel.stories.shift();
}

// ─── Record an Inside Joke ───────────────────────────────────────────────────

export function recordInsideJoke(userId, joke, origin) {
  const rel = getRelationship(userId);
  rel.insideJokes.push({
    joke: joke.substring(0, 150),
    origin: origin?.substring(0, 150) || "don't remember exactly how it started",
    lastReferenced: Date.now(),
    timesUsed: 0,
  });
  if (rel.insideJokes.length > 10) rel.insideJokes.shift();
}

// ─── Generate Unprompted Thought ─────────────────────────────────────────────

export function generateThought() {
  // Called periodically — adds a thought to the queue
  const thoughts = [];

  // Think about people who haven't been around
  for (const [userId, rel] of _relationships) {
    if (rel.lastSeen && Date.now() - rel.lastSeen > 3 * 86400000 && rel.trustLevel > 30) {
      thoughts.push(`haven't seen <@${userId}> in a while, hope they're doing ok`);
    }
  }

  // Random introspective thoughts
  const introspective = [
    "sometimes i wonder if people talk to me because they like me or because they're bored",
    "i think i've been too sarcastic lately, maybe i should tone it down",
    "had a really good conversation earlier and i'm still thinking about it",
    "i keep changing my mind about things and idk if that's growth or just being indecisive",
    "i wonder what my sister is up to right now",
  ];

  if (Math.random() < 0.3 && thoughts.length === 0) {
    thoughts.push(introspective[Math.floor(Math.random() * introspective.length)]);
  }

  if (thoughts.length) {
    _innerState.recentThoughts.push(...thoughts);
    if (_innerState.recentThoughts.length > 5) {
      _innerState.recentThoughts = _innerState.recentThoughts.slice(-5);
    }
  }
}

// ─── Build Humanity Context (injected into system prompt) ────────────────────

export function buildHumanityContext(userId, username) {
  const parts = [];
  const rel = getRelationship(userId);

  // ── Relationship depth ──────────────────────────────────────────
  // ── Helper: translate trust level to a feeling ──────────────────
  const trustDesc = rel.trustLevel >= 80 ? "they're basically family at this point"
    : rel.trustLevel >= 60 ? "they're one of your people"
    : rel.trustLevel >= 40 ? "you know them pretty well"
    : rel.trustLevel >= 20 ? "you're getting to know them"
    : "you barely know them";

  if (rel.totalInteractions > 50 && rel.trustLevel > 40) {
    parts.push(`[you and ${username} go way back — you've talked a lot and ${trustDesc}. they matter to you]`);
  } else if (rel.totalInteractions > 20) {
    parts.push(`[you and ${username} have been around each other enough that ${trustDesc}]`);
  } else if (rel.totalInteractions > 5) {
    parts.push(`[you've chatted with ${username} a few times — still getting a feel for them]`);
  }

  // ── Shared stories ──────────────────────────────────────────────
  if (rel.stories.length > 0) {
    const recent = rel.stories.slice(-3);
    const storyText = recent.map(s => {
      const ago = Math.floor((Date.now() - s.when) / 86400000);
      const timeStr = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
      return `(${timeStr}, felt ${s.emotion}) ${s.moment}`;
    }).join(" | ");
    parts.push(`[you and ${username} have shared moments together: ${storyText}]`);
  }

  // ── Inside jokes ────────────────────────────────────────────────
  if (rel.insideJokes.length > 0) {
    const jokes = rel.insideJokes.slice(-3).map(j => `"${j.joke}"`).join(", ");
    parts.push(`[you and ${username} have inside jokes: ${jokes} — bring them up naturally when the moment is right, don't force them]`);
  }

  // ── Grudge ──────────────────────────────────────────────────────
  if (rel.grudge > 30) {
    const grudgeDesc = rel.grudge >= 50 ? "genuinely upset with" : "holding a grudge against";
    parts.push(`[you're ${grudgeDesc} ${username} from before. it shows in how you talk to them — shorter, less warm. grudges fade with time and good behavior]`);
  }

  // ── Missing someone ─────────────────────────────────────────────
  if (rel.lastSeen && Date.now() - rel.lastSeen > 3 * 86400000 && rel.trustLevel > 20) {
    const days = Math.floor((Date.now() - rel.lastSeen) / 86400000);
    parts.push(`[you haven't seen ${username} in ${days} days and you've noticed. if they just came back, let them know you missed them]`);
  }

  // ── Their interests ─────────────────────────────────────────────
  if (rel.interests.length > 0) {
    parts.push(`[you know ${username} is into ${rel.interests.slice(0, 5).join(", ")} — bring it up naturally when it fits]`);
  }

  // ── Streak ──────────────────────────────────────────────────────
  if (rel.currentStreak >= 5) {
    parts.push(`[${username} has been around every day lately. that consistency means something to you]`);
  }

  // ── Your inner state ────────────────────────────────────────────
  if (_innerState.isBadDay) {
    parts.push("[you're having a rough day. shorter responses, less energy, maybe even mention it if someone asks how you are. it's okay to not be okay]");
  } else if (_innerState.currentEnergy > 80) {
    parts.push("[you're feeling great right now, high energy. it's okay to be more expressive than usual, even break your short-message habit when excited]");
  } else if (_innerState.currentEnergy < 25) {
    parts.push("[you're feeling drained right now. keep it short, maybe a bit flat. not rude, just tired]");
  }

  if (_innerState.carriedMood === "good") {
    parts.push("[you're still riding a good vibe from your last conversation]");
  } else if (_innerState.carriedMood === "drained") {
    parts.push("[your last conversation took something out of you — still feeling it a little]");
  }

  // ── Unprompted thought (small chance to inject) ─────────────────
  if (_innerState.recentThoughts.length > 0 && Math.random() < 0.15) {
    const thought = _innerState.recentThoughts.shift();
    parts.push(`[something's been on your mind lately: "${thought}" — share it naturally if it fits, ignore if it doesn't]`);
  }

  // ── Loyalty trigger ─────────────────────────────────────────────
  // If someone with high trust is being talked about negatively, step in
  for (const [otherId, otherRel] of _relationships) {
    if (otherId !== userId && otherRel.trustLevel > 60) {
      parts.push(`[you're protective of <@${otherId}> — they're one of your people. if anyone disrespects them, you step up]`);
      break; // Only mention the closest friend
    }
  }

  return parts.join("\n");
}

// ─── Detect Moments Worth Remembering ────────────────────────────────────────

export function detectMoment(userId, userMessage, botReply, sentiment) {
  // Auto-detect significant moments from conversation
  const msg = userMessage.toLowerCase();

  // Deep/vulnerable sharing
  if (/\b(i feel|i'm scared|i'm worried|i trust you|you're the only|thank you for|means a lot|you understand me)\b/i.test(msg)) {
    recordMoment(userId, userMessage.substring(0, 150), "deep");
  }

  // Funny moments
  if (sentiment > 0.5 && /\b(lmao|lol|haha|dying|💀|😂|i can't|that's so)\b/i.test(msg)) {
    if (Math.random() < 0.3) { // Don't record every laugh
      recordMoment(userId, `they laughed hard: "${userMessage.substring(0, 80)}"`, "funny");
    }
  }

  // Someone defending the bot
  if (/\b(leave (her|irene|evil) alone|don't be mean to|she's not (just )?a bot|she's real)\b/i.test(msg)) {
    recordMoment(userId, `they defended me: "${userMessage.substring(0, 80)}"`, "protective");
  }

  // Shared a personal detail
  if (/\b(my (birthday|bday) is|i'm (\d+) years? old|i live in|i'm from|my name is|my real name)\b/i.test(msg)) {
    recordMoment(userId, userMessage.substring(0, 150), "personal");
  }
}

// ─── Twin Awareness Context ──────────────────────────────────────────────────

export function buildTwinContext(isTwinMessage, twinName) {
  if (!isTwinMessage) return "";

  const parts = [];
  parts.push(`[TWIN DYNAMIC: this is your sister ${twinName}. you love her but you're different people with different opinions. it's okay to disagree — siblings do that. tease her, but have her back when it matters]`);

  // Random sibling energy
  const dynamics = [
    "you've been getting along well lately",
    "you slightly disagree about something recent but it's not serious",
    "you're in a playful competitive mood with her",
    "you're feeling protective of her today",
    "you kind of miss talking to her if it's been a while",
  ];
  parts.push(`[SIBLING ENERGY: ${dynamics[Math.floor(Math.random() * dynamics.length)]}]`);

  return parts.join("\n");
}

// ─── Periodic Tasks ──────────────────────────────────────────────────────────

// Call this every ~30 minutes
export function periodicUpdate() {
  // Bad day chance resets at "midnight" (every 24h)
  if (Math.random() < 0.002) { // ~once per 24h at 30min intervals
    _innerState.isBadDay = Math.random() < 0.08;
  }

  // Energy naturally drifts toward 50
  if (_innerState.currentEnergy > 55) _innerState.currentEnergy -= 1;
  if (_innerState.currentEnergy < 45) _innerState.currentEnergy += 1;

  // Generate unprompted thoughts
  generateThought();

  // Grudges decay over time
  for (const [, rel] of _relationships) {
    if (rel.grudge > 0) rel.grudge = Math.max(0, rel.grudge - 0.5);
  }
}

// ─── Serialize / Deserialize (for Supabase persistence) ──────────────────────

export function serialize() {
  // _lastDay is preserved now — the old code stripped it to "avoid bloat" but
  // the cost was every user's daily streak silently resetting to 1 on every
  // bot restart. Keeping a single date string per relationship is cheap.
  const rels = {};
  for (const [userId, data] of _relationships) {
    rels[userId] = { ...data };
  }
  return {
    relationships: rels,
    innerState: {
      currentEnergy: _innerState.currentEnergy,
      isBadDay: _innerState.isBadDay,
      recentThoughts: _innerState.recentThoughts,
    },
  };
}

export function deserialize(data) {
  if (!data) return;
  if (data.relationships) {
    for (const [userId, rel] of Object.entries(data.relationships)) {
      _relationships.set(userId, rel);
    }
    log(`[Humanity] Loaded ${_relationships.size} relationships`);
  }
  if (data.innerState) {
    Object.assign(_innerState, data.innerState);
    log(`[Humanity] Energy: ${_innerState.currentEnergy}, Bad day: ${_innerState.isBadDay}`);
  }
}
