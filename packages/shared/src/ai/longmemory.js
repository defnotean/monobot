// @ts-nocheck -- factory binds untyped bot-local config/db/semantic modules;
// behavior is covered by focused shared tests and the bot shims preserve the
// exact historical export surface.
import { LRUCache } from "../LRUCache.js";

const EPISODE = {
  RUNNING_BIT: "running_bit",
  UNRESOLVED_TENSION: "tension",
  FUNNY_MOMENT: "funny",
  VENTING_SESSION: "venting",
  BONDING_MOMENT: "bond",
  SHARED_OPINION: "opinion",
  CALLBACK: "callback",
};

function noop() {}

function createMoodStore({ strategy = "fifo", limit = 50 } = {}) {
  if (strategy === "lru") return new LRUCache(limit);
  return new Map();
}

function moodObject(moodStore) {
  const obj = {};
  for (const [k, v] of moodStore) obj[k] = v;
  return obj;
}

function similarJaccard(a, b) {
  const wa = new Set(a.toLowerCase().match(/\b\w{3,}\b/g) || []);
  const wb = new Set(b.toLowerCase().match(/\b\w{3,}\b/g) || []);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return (inter / union) > 0.7;
}

function similarPrefix(thought, last) {
  const lower = thought.toLowerCase();
  const lastLower = last.toLowerCase();
  return lower.includes(lastLower.substring(0, 30)) || lastLower.includes(lower.substring(0, 30));
}

function shouldDedupeThought(mode, thought, last) {
  if (mode === "jaccard") return similarJaccard(thought, last);
  return similarPrefix(thought, last);
}

function isThoughtAnchor(mode, botResponse, lower) {
  if (mode === "clause") {
    return /(?:^|[.!?]\s+|[""'']\s*)(random thought|i was thinking|i just realized|you know what|now that i think|i wonder|hmm actually)\b/i.test(botResponse);
  }
  return /\b(random thought|i was thinking|i just realized|you know what|now that i think|i wonder|hmm actually)\b/i.test(lower);
}

function timeoutAfter(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref?.();
  });
}

/**
 * Build a long-term memory module bound to one bot's local dependencies.
 *
 * Deps are lazy functions to avoid bot-local import cycles and to keep config
 * changes visible without recreating the module.
 *
 * @param {any} [options]
 */
export function createLongMemory({
  longMemoryRowId = "long_memory",
  consciousnessRowId = "consciousness",
  defaultBotId = "bot",
  defaultBotName = "Bot",
  getDatabase = async () => null,
  getSemantic = async () => null,
  getConfig = async () => ({}),
  getPersonality = async () => null,
  getGeminiModel = async () => {
    const cfg = await getConfig();
    return cfg?.geminiModel || "gemini-2.5-flash";
  },
  moodCache = { strategy: "fifo", limit: 50 },
  capMoodOnInfer = moodCache?.strategy === "lru",
  thoughtDedupeMode = "prefix",
  thoughtExtractionMode = "anywhere",
  // Pre-push eviction thresholds. Eris's originals checked `length >= cap`
  // (effective caps 15/10); Irene's checked `length > cap` (16/11) — pass
  // { user: 16, channel: 11 } to keep Irene's historical buffer sizes.
  episodeCaps = { user: 15, channel: 10 },
  semanticLogging = "silent",
  log = noop,
  saveDelayMs = 30_000,
  thoughtTimeoutMs = 5_000,
  random = Math.random,
  now = Date.now,
} = {}) {
  void getPersonality;

  const _episodes = new Map();
  const _channelEpisodes = new Map();
  const _moodNarratives = createMoodStore(moodCache);
  let _monologue = [];
  let _dirty = false;
  let _saveTimer = null;
  let _lastThoughtGen = 0;

  const _log = typeof log === "function" ? log : noop;
  const moodLimit = Math.max(1, Number(moodCache?.limit || 50));
  const moodStrategy = moodCache?.strategy === "lru" ? "lru" : "fifo";

  function logSemantic(message) {
    if (semanticLogging === "log") _log(message);
  }

  async function getSupabase() {
    const db = await getDatabase();
    return db?.getSupabase?.() || null;
  }

  async function resolveBotId() {
    const cfg = await getConfig();
    return cfg?.botName || defaultBotId;
  }

  function setMood(key, value, { enforceLimit = true } = {}) {
    _moodNarratives.set(key, value);
    if (moodStrategy === "fifo" && enforceLimit && _moodNarratives.size > moodLimit) {
      const oldest = _moodNarratives.keys().next().value;
      _moodNarratives.delete(oldest);
    }
  }

  function updateMoodNarrative(reason, contextKey = "global") {
    setMood(contextKey, reason);
    scheduleSave();
  }

  function inferMoodNarrative(userMessage, botResponse, sentiment, userId) {
    if (Math.abs(sentiment) < 0.3) return;
    const key = userId || "global";

    if (sentiment < -0.5) {
      setMood(key, `irritated — someone was being negative. "${userMessage.substring(0, 50)}"`, { enforceLimit: capMoodOnInfer });
    } else if (sentiment < -0.3) {
      setMood(key, "a little off — the vibe was weird just now", { enforceLimit: capMoodOnInfer });
    } else if (sentiment > 0.5) {
      setMood(key, "feeling good — had a nice interaction just now", { enforceLimit: capMoodOnInfer });
    } else if (sentiment > 0.3) {
      setMood(key, "decent mood — people are being chill", { enforceLimit: capMoodOnInfer });
    }
    scheduleSave();
  }

  function getMoodNarrative(contextKey = "global") {
    return _moodNarratives.get(contextKey) || _moodNarratives.get("global") || "";
  }

  function addThought(thought) {
    if (!thought || thought.length < 5) return;
    if (_monologue.length > 0) {
      const last = _monologue[_monologue.length - 1].thought;
      if (shouldDedupeThought(thoughtDedupeMode, thought, last)) return;
    }
    _monologue.push({
      thought: thought.substring(0, 200),
      at: now(),
    });
    if (_monologue.length > 15) _monologue.shift();
    scheduleSave();
  }

  function extractThoughts(botResponse) {
    if (!botResponse) return;
    const lower = botResponse.toLowerCase();
    if (isThoughtAnchor(thoughtExtractionMode, botResponse, lower)) {
      addThought(botResponse.substring(0, 120));
    }
    if (/\b(curious about|wanna know more|that's interesting|i should look into)\b/i.test(lower)) {
      addThought(`curious about: ${botResponse.match(/\b(?:curious about|wanna know more about|interested in)\s+([^.!?\n]+)/i)?.[1] || botResponse.substring(0, 50)}`);
    }
  }

  async function generateInnerThought(userMessage, botResponse, username, geminiClient, botName = defaultBotName) {
    if (!geminiClient || !userMessage || !botResponse) return;
    if (now() - _lastThoughtGen < 60_000) return;
    if (random() > 0.4) return;
    _lastThoughtGen = now();

    try {
      const model = await getGeminiModel();
      const response = await Promise.race([
        geminiClient.models.generateContent({
          model,
          contents: [{ parts: [{ text: `You are ${botName}'s subconscious. She just had this exchange:\nUser (${username}): "${userMessage.substring(0, 100)}"\n${botName}: "${botResponse.substring(0, 100)}"\n\nWrite ONE brief inner thought she'd have after this (max 15 words). Write in third person like a narrator: "${botName} wondered..." or "${botName} felt..." or "${botName} made a mental note..."\nExamples:\n- "${botName} wondered if they actually meant that"\n- "${botName} made a mental note to check on them later"\n- "${botName} felt a little proud of that comeback"\n- "${botName} noticed they seemed off today"\nDo NOT use quotes. Just the thought.` }] }],
          config: { maxOutputTokens: 40 },
        }),
        timeoutAfter(thoughtTimeoutMs),
      ]);
      const thought = response.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
      if (thought && thought.length > 10 && thought.length < 200) {
        addThought(thought);
      }
    } catch {}
  }

  function getMonologue() {
    return _monologue.filter(t => now() - t.at < 21600_000);
  }

  function getEpisodes() { return _episodes; }
  function getChannelEpisodes() { return _channelEpisodes; }

  function recordEpisode(userId, channelId, episode) {
    if (!episode.type || !episode.content) return;

    episode.at = now();
    episode.userId = userId;

    if (!_episodes.has(userId)) _episodes.set(userId, []);
    const userEps = _episodes.get(userId);
    if (userEps.length >= (episodeCaps?.user ?? 15)) userEps.shift();
    userEps.push(episode);

    if (channelId) {
      if (!_channelEpisodes.has(channelId)) _channelEpisodes.set(channelId, []);
      const chEps = _channelEpisodes.get(channelId);
      if (chEps.length >= (episodeCaps?.channel ?? 10)) chEps.shift();
      chEps.push(episode);
    }

    scheduleSave();
  }

  async function analyzeExchange(userId, channelId, userMessage, botResponse, sentiment) {
    if (!userMessage || !botResponse) return;
    const userLower = userMessage.toLowerCase();
    const botLower = botResponse.toLowerCase();

    const userEps = _episodes.get(userId) || [];
    for (const ep of userEps) {
      if (ep.type === EPISODE.RUNNING_BIT && ep.phrase) {
        if (userLower.includes(ep.phrase) || botLower.includes(ep.phrase)) {
          ep.count = (ep.count || 1) + 1;
          ep.lastUsed = now();
          scheduleSave();
          return;
        }
      }
    }

    if (sentiment < -0.4 || /\b(no that's wrong|disagree|nah that's|you're wrong|bad take)\b/i.test(botLower)) {
      recordEpisode(userId, channelId, {
        type: EPISODE.UNRESOLVED_TENSION,
        content: `argued about: "${userMessage.substring(0, 80)}" — she said: "${botResponse.substring(0, 80)}"`,
      });
      inferMoodNarrative(userMessage, botResponse, sentiment, userId);
    }

    if (/\b(i'm so (tired|stressed|sad|frustrated|done|over it)|having a bad|rough day|can't deal)\b/i.test(userLower)) {
      recordEpisode(userId, channelId, {
        type: EPISODE.VENTING_SESSION,
        content: `user was venting: "${userMessage.substring(0, 80)}"`,
      });
    }

    if (sentiment > 0.5 || /\b(thank you|you're the best|appreciate you|means a lot|ily|love you)\b/i.test(userLower)) {
      recordEpisode(userId, channelId, {
        type: EPISODE.BONDING_MOMENT,
        content: `bonded: "${userMessage.substring(0, 60)}" → "${botResponse.substring(0, 60)}"`,
      });
      inferMoodNarrative(userMessage, botResponse, sentiment, userId);
    }

    if (/\b(i think|honestly|imo|ngl|tbh|hot take|unpopular opinion)\b/i.test(botLower)) {
      recordEpisode(userId, channelId, {
        type: EPISODE.SHARED_OPINION,
        content: `shared opinion: "${botResponse.substring(0, 100)}"`,
      });
    }

    if (botResponse.length < 80 && sentiment > 0.2 && /\b(lol|lmao|haha|💀|😭)\b/i.test(botLower)) {
      const key = botResponse.toLowerCase().replace(/[^a-z ]/g, "").trim().substring(0, 30);
      if (key.length > 5) {
        recordEpisode(userId, channelId, {
          type: EPISODE.RUNNING_BIT,
          phrase: key,
          content: botResponse.substring(0, 60),
          count: 1,
          lastUsed: now(),
        });
      }
    }

    extractThoughts(botResponse);

    try {
      const semantic = await getSemantic();
      const storeEpisode = semantic?.storeEpisode;
      if (typeof storeEpisode !== "function") return;
      const botId = await resolveBotId();

      if (sentiment < -0.4 || sentiment > 0.5 ||
          /\b(running bit|inside joke|argued|bonded|venting|opinion)\b/i.test(botResponse) ||
          /\b(i think|honestly|imo|ngl|tbh)\b/i.test(botLower)) {
        const summary = `user said: "${userMessage.substring(0, 100)}" — bot replied: "${botResponse.substring(0, 100)}"`;
        const type = sentiment < -0.3 ? "tension" : sentiment > 0.3 ? "bond" : "exchange";
        storeEpisode(botId, userId, channelId, null, type, summary)
          .catch((err) => logSemantic(`[LongMemory] storeEpisode failed: ${err.message}`));
      }
    } catch (err) {
      logSemantic(`[LongMemory] analyzeExchange outer error: ${err.message}`);
    }
  }

  async function buildLongTermContext(userId, channelId, currentMessage = "") {
    const parts = [];

    const narrative = getMoodNarrative(userId) || getMoodNarrative("global");
    if (narrative) {
      parts.push(`[MOOD REASON: ${narrative}]`);
    }

    const thoughts = getMonologue();
    if (thoughts.length) {
      parts.push(`[RECENT THOUGHTS: ${thoughts.map(t => `"${t.thought}"`).join(", ")}]`);
    }

    try {
      const sb = await getSupabase();
      if (sb) {
        const { data: row } = await sb.from("bot_data").select("data").eq("id", consciousnessRowId).single();
        if (row?.data) {
          const goals = row.data.goals;
          const refs = row.data.reflections;
          const allGoals = [...(goals?.short || []), ...(goals?.medium || []), ...(goals?.long || [])];
          if (allGoals.length) {
            parts.push(`[YOUR CURRENT ASPIRATIONS: ${allGoals.slice(0, 3).join("; ")}]`);
          }
          if (refs?.length) {
            parts.push(`[SELF-REFLECTION: ${refs.slice(-2).map(r => `"${r.text}"`).join(", ")}]`);
          }
        }
      }
    } catch {}

    const userEps = _episodes.get(userId) || [];
    const recentEps = userEps
      .filter(e => now() - e.at < 7 * 86400_000)
      .slice(-5);

    if (recentEps.length) {
      const epSummaries = recentEps.map(e => {
        const hours = Math.floor((now() - e.at) / 3600_000);
        const timeAgo = hours < 1 ? "just now" : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
        return `(${timeAgo}) ${e.content}`;
      });
      parts.push(`[HISTORY WITH THIS PERSON: ${epSummaries.join(" | ")}]`);
    }

    const bits = userEps.filter(e => e.type === EPISODE.RUNNING_BIT && (e.count || 0) >= 2);
    if (bits.length) {
      parts.push(`[RUNNING BITS: ${bits.map(b => `"${b.phrase || b.content}" (${b.count}x)`).join(", ")}]`);
    }

    const chEps = _channelEpisodes.get(channelId) || [];
    const recentCh = chEps.filter(e => now() - e.at < 3600_000);
    if (recentCh.length > 1) {
      const tensions = recentCh.filter(e => e.type === EPISODE.UNRESOLVED_TENSION).length;
      const bonds = recentCh.filter(e => e.type === EPISODE.BONDING_MOMENT).length;
      if (tensions > bonds) parts.push("[CHANNEL ENERGY: tense vibes recently. tread carefully or address it]");
      else if (bonds > 1) parts.push("[CHANNEL ENERGY: warm vibes. match the energy]");
    }

    if (currentMessage) {
      try {
        const semantic = await getSemantic();
        const searchRelevantMemories = semantic?.searchRelevantMemories;
        if (typeof searchRelevantMemories === "function") {
          const botId = await resolveBotId();
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
        }
      } catch {}
    }

    return parts.join("\n");
  }

  function scheduleSave() {
    _dirty = true;
    if (_saveTimer) return;
    _saveTimer = setTimeout(async () => {
      _saveTimer = null;
      if (!_dirty) return;
      try {
        const supabase = await getSupabase();
        if (!supabase) return;

        const episodes = {};
        for (const [k, v] of _episodes) episodes[k] = v.slice(-10);
        const channels = {};
        for (const [k, v] of _channelEpisodes) channels[k] = v.slice(-8);

        try {
          await supabase.from("bot_data").upsert({
            id: longMemoryRowId,
            data: {
              episodes,
              channels,
              moodNarratives: moodObject(_moodNarratives),
              monologue: _monologue,
            },
          });
        } catch {}

        _dirty = false;
      } catch (e) {
        _log(`[LongMemory] Save failed: ${e.message}`);
      }
    }, saveDelayMs);
  }

  async function flush() {
    if (!_dirty) return;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try {
      const supabase = await getSupabase();
      if (!supabase) return;
      const episodes = {};
      for (const [k, v] of _episodes) episodes[k] = v.slice(-10);
      const channels = {};
      for (const [k, v] of _channelEpisodes) channels[k] = v.slice(-8);
      await supabase.from("bot_data").upsert({
        id: longMemoryRowId,
        data: { episodes, channels, moodNarratives: moodObject(_moodNarratives), monologue: _monologue },
      });
      _dirty = false;
    } catch (e) {
      _log(`[LongMemory] Flush failed: ${e.message}`);
    }
  }

  async function loadLongMemory() {
    try {
      const supabase = await getSupabase();
      if (!supabase) return;

      const { data: row } = await supabase.from("bot_data").select("data").eq("id", longMemoryRowId).single();
      if (row?.data) {
        if (row.data.episodes) for (const [k, v] of Object.entries(row.data.episodes)) _episodes.set(k, v);
        if (row.data.channels) for (const [k, v] of Object.entries(row.data.channels)) _channelEpisodes.set(k, v);
        if (row.data.moodNarratives) {
          for (const [k, v] of Object.entries(row.data.moodNarratives)) setMood(k, v, { enforceLimit: false });
        } else if (row.data.moodNarrative) {
          setMood("global", row.data.moodNarrative, { enforceLimit: false });
        }
        if (row.data.monologue) _monologue = row.data.monologue;
        _log(`[LongMemory] Loaded: ${_episodes.size} users, ${_channelEpisodes.size} channels, monologue: ${_monologue.length}`);
      }
    } catch (e) {
      _log(`[LongMemory] Load failed: ${e.message}`);
    }
  }

  function reset() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _episodes.clear();
    _channelEpisodes.clear();
    _moodNarratives.clear();
    _monologue = [];
    _dirty = false;
    _saveTimer = null;
    _lastThoughtGen = 0;
  }

  return {
    updateMoodNarrative,
    inferMoodNarrative,
    getMoodNarrative,
    addThought,
    extractThoughts,
    generateInnerThought,
    getMonologue,
    getEpisodes,
    getChannelEpisodes,
    recordEpisode,
    analyzeExchange,
    buildLongTermContext,
    flush,
    loadLongMemory,
    _internal: {
      EPISODE,
      reset,
      get dirty() { return _dirty; },
      get moodNarratives() { return _moodNarratives; },
    },
  };
}

export const _internal = {
  EPISODE,
  similarJaccard,
  similarPrefix,
  shouldDedupeThought,
  isThoughtAnchor,
};
