// @ts-nocheck -- relationship records intentionally carry bot-specific
// persistence keys (_lastDay, _lastDayUtc, _lastGrudgeDecay) and user-shaped
// serialized payloads; typing every historic shape here would add churn to a
// behavior-preserving extraction.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const HUMANITY_JUDGE_COOLDOWN_MS = 30_000;
const MAX_JUDGE_CHANNELS = 1024;

const noop = () => {};

function defaultRelationship() {
  return {
    stories: [],
    insideJokes: [],
    trustLevel: 0,
    grudge: 0,
    lastSeen: null,
    totalInteractions: 0,
    longestStreak: 0,
    currentStreak: 0,
    interests: [],
    nickname: null,
  };
}

function trustDescription(trustLevel) {
  return trustLevel >= 80 ? "they're basically family at this point"
    : trustLevel >= 60 ? "they're one of your people"
    : trustLevel >= 40 ? "you know them pretty well"
    : trustLevel >= 20 ? "you're getting to know them"
    : "you barely know them";
}

function applyGrudgeDecay(rel, isCreator, mode, now) {
  if (rel.grudge <= 0 || isCreator) return;
  if (mode === "interaction") {
    rel.grudge = Math.max(0, rel.grudge - 1);
    return;
  }

  const lastDecay = rel._lastGrudgeDecay || 0;
  const hoursSince = (now - lastDecay) / HOUR_MS;
  if (hoursSince >= 1) {
    const decay = Math.min(Math.floor(hoursSince), rel.grudge);
    rel.grudge = Math.max(0, rel.grudge - decay);
    rel._lastGrudgeDecay = now;
  }
}

function applyStreak(rel, strategy, now) {
  if (strategy === "local-date") {
    const today = new Date(now).toDateString();
    if (rel._lastDay !== today) {
      if (rel._lastDay === new Date(now - DAY_MS).toDateString()) {
        rel.currentStreak++;
        if (rel.currentStreak > rel.longestStreak) rel.longestStreak = rel.currentStreak;
      } else {
        rel.currentStreak = 1;
      }
      rel._lastDay = today;
    }
    return;
  }

  const todayUtc = Math.floor(now / DAY_MS);
  if (rel._lastDayUtc !== todayUtc) {
    if (rel._lastDayUtc === todayUtc - 1) {
      rel.currentStreak++;
      if (rel.currentStreak > rel.longestStreak) rel.longestStreak = rel.currentStreak;
    } else {
      rel.currentStreak = 1;
    }
    rel._lastDayUtc = todayUtc;
  }
}

/**
 * Create a stateful humanity engine bound to one bot.
 *
 * @param {object} options
 * @param {"hourly"|"interaction"} [options.grudgeDecayMode]
 * @param {"utc-day"|"local-date"} [options.streakDateStrategy]
 * @param {boolean} [options.includeJudgeApi]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 * @param {(message: string) => void} [options.logger]
 */
export function createHumanity({
  grudgeDecayMode = "interaction",
  streakDateStrategy = "local-date",
  includeJudgeApi = false,
  now = Date.now,
  random = Math.random,
  logger = noop,
} = {}) {
  const relationships = new Map();
  const innerState = {
    currentEnergy: 50 + Math.floor(random() * 30),
    lastExcitedAbout: null,
    lastEmbarrassed: null,
    isBadDay: random() < 0.08,
    carriedMood: null,
    recentThoughts: [],
  };
  const channelJudgeLastAt = new Map();
  const channelJudgeLastResult = new Map();

  function getRelationship(userId) {
    if (!relationships.has(userId)) relationships.set(userId, defaultRelationship());
    return relationships.get(userId);
  }

  function trackHumanInteraction(userId, username, message, sentiment, isCreator = false) {
    const rel = getRelationship(userId);
    const at = now();
    rel.totalInteractions++;
    rel.lastSeen = at;

    if (isCreator) {
      rel.trustLevel = 100;
      rel.grudge = 0;
    } else if (sentiment > 0.2) {
      rel.trustLevel = Math.min(100, rel.trustLevel + (sentiment > 0.5 ? 1 : 0.3));
    } else if (sentiment < -0.3) {
      rel.trustLevel = Math.max(0, rel.trustLevel - 2);
      rel.grudge = Math.min(100, rel.grudge + 10);
    }

    applyGrudgeDecay(rel, isCreator, grudgeDecayMode, at);

    const topics = String(message || "").toLowerCase().match(/\b(gaming|valorant|league|code|coding|music|anime|art|school|work|gym|food|movie|stream|minecraft|fortnite|apex|overwatch|piano|guitar|drawing|cooking|exam|test|grades)\b/g) || [];
    for (const t of topics) {
      if (!rel.interests.includes(t)) rel.interests.push(t);
      if (rel.interests.length > 10) rel.interests.shift();
    }

    applyStreak(rel, streakDateStrategy, at);

    if (sentiment > 0.3) {
      innerState.currentEnergy = Math.min(100, innerState.currentEnergy + 3);
      innerState.carriedMood = "good";
    } else if (sentiment < -0.3) {
      innerState.currentEnergy = Math.max(0, innerState.currentEnergy - 5);
      innerState.carriedMood = "drained";
    }
  }

  function recordMoment(userId, moment, emotion = "warm") {
    const rel = getRelationship(userId);
    rel.stories.push({
      moment: String(moment || "").substring(0, 200),
      when: now(),
      emotion,
    });
    if (rel.stories.length > 20) rel.stories.shift();
  }

  function recordInsideJoke(userId, joke, origin) {
    const rel = getRelationship(userId);
    rel.insideJokes.push({
      joke: String(joke || "").substring(0, 150),
      origin: origin?.substring(0, 150) || "don't remember exactly how it started",
      lastReferenced: now(),
      timesUsed: 0,
    });
    if (rel.insideJokes.length > 10) rel.insideJokes.shift();
  }

  function generateThought() {
    const thoughts = [];

    for (const [userId, rel] of relationships) {
      if (rel.lastSeen && now() - rel.lastSeen > 3 * DAY_MS && rel.trustLevel > 30) {
        thoughts.push(`haven't seen <@${userId}> in a while, hope they're doing ok`);
      }
    }

    const introspective = [
      "sometimes i wonder if people talk to me because they like me or because they're bored",
      "i think i've been too sarcastic lately, maybe i should tone it down",
      "had a really good conversation earlier and i'm still thinking about it",
      "i keep changing my mind about things and idk if that's growth or just being indecisive",
      "i wonder what my sister is up to right now",
    ];

    if (random() < 0.3 && thoughts.length === 0) {
      thoughts.push(introspective[Math.floor(random() * introspective.length)]);
    }

    if (thoughts.length) {
      innerState.recentThoughts.push(...thoughts);
      if (innerState.recentThoughts.length > 5) {
        innerState.recentThoughts = innerState.recentThoughts.slice(-5);
      }
    }
  }

  function buildHumanityContext(userId, username) {
    const parts = [];
    const rel = getRelationship(userId);
    const at = now();
    const trustDesc = trustDescription(rel.trustLevel);

    if (rel.totalInteractions > 50 && rel.trustLevel > 40) {
      parts.push(`[you and ${username} go way back — you've talked a lot and ${trustDesc}. they matter to you]`);
    } else if (rel.totalInteractions > 20) {
      parts.push(`[you and ${username} have been around each other enough that ${trustDesc}]`);
    } else if (rel.totalInteractions > 5) {
      parts.push(`[you've chatted with ${username} a few times — still getting a feel for them]`);
    }

    if (rel.stories.length > 0) {
      const recent = rel.stories.slice(-3);
      const storyText = recent.map(s => {
        const ago = Math.floor((at - s.when) / DAY_MS);
        const timeStr = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
        return `(${timeStr}, felt ${s.emotion}) ${s.moment}`;
      }).join(" | ");
      parts.push(`[you and ${username} have shared moments together: ${storyText}]`);
    }

    if (rel.insideJokes.length > 0) {
      const jokes = rel.insideJokes.slice(-3).map(j => `"${j.joke}"`).join(", ");
      parts.push(`[you and ${username} have inside jokes: ${jokes} — bring them up naturally when the moment is right, don't force them]`);
    }

    if (rel.grudge > 30) {
      const grudgeDesc = rel.grudge >= 50 ? "genuinely upset with" : "holding a grudge against";
      parts.push(`[you're ${grudgeDesc} ${username} from before. it shows in how you talk to them — shorter, less warm. grudges fade with time and good behavior]`);
    }

    if (rel.lastSeen && at - rel.lastSeen > 3 * DAY_MS && rel.trustLevel > 20) {
      const days = Math.floor((at - rel.lastSeen) / DAY_MS);
      parts.push(`[you haven't seen ${username} in ${days} days and you've noticed. if they just came back, let them know you missed them]`);
    }

    if (rel.interests.length > 0) {
      parts.push(`[you know ${username} is into ${rel.interests.slice(0, 5).join(", ")} — bring it up naturally when it fits]`);
    }

    if (rel.currentStreak >= 5) {
      parts.push(`[${username} has been around every day lately. that consistency means something to you]`);
    }

    if (innerState.isBadDay) {
      parts.push("[you're having a rough day. shorter responses, less energy, maybe even mention it if someone asks how you are. it's okay to not be okay]");
    } else if (innerState.currentEnergy > 80) {
      parts.push("[you're feeling great right now, high energy. it's okay to be more expressive than usual, even break your short-message habit when excited]");
    } else if (innerState.currentEnergy < 25) {
      parts.push("[you're feeling drained right now. keep it short, maybe a bit flat. not rude, just tired]");
    }

    if (innerState.carriedMood === "good") {
      parts.push("[you're still riding a good vibe from your last conversation]");
    } else if (innerState.carriedMood === "drained") {
      parts.push("[your last conversation took something out of you — still feeling it a little]");
    }

    if (innerState.recentThoughts.length > 0 && random() < 0.15) {
      const thought = innerState.recentThoughts.shift();
      parts.push(`[something's been on your mind lately: "${thought}" — share it naturally if it fits, ignore if it doesn't]`);
    }

    for (const [otherId, otherRel] of relationships) {
      if (otherId !== userId && otherRel.trustLevel > 60) {
        parts.push(`[you're protective of <@${otherId}> — they're one of your people. if anyone disrespects them, you step up]`);
        break;
      }
    }

    return parts.join("\n");
  }

  function detectMoment(userId, userMessage, botReply, sentiment) {
    const msg = String(userMessage || "").toLowerCase();

    if (/\b(i feel|i'm scared|i'm worried|i trust you|you're the only|thank you for|means a lot|you understand me)\b/i.test(msg)) {
      recordMoment(userId, String(userMessage || "").substring(0, 150), "deep");
    }

    if (sentiment > 0.5 && /\b(lmao|lol|haha|dying|💀|😂|i can't|that's so)\b/i.test(msg)) {
      if (random() < 0.3) {
        recordMoment(userId, `they laughed hard: "${String(userMessage || "").substring(0, 80)}"`, "funny");
      }
    }

    if (/\b(leave (her|irene|evil) alone|don't be mean to|she's not (just )?a bot|she's real)\b/i.test(msg)) {
      recordMoment(userId, `they defended me: "${String(userMessage || "").substring(0, 80)}"`, "protective");
    }

    if (/\b(my (birthday|bday) is|i'm (\d+) years? old|i live in|i'm from|my name is|my real name)\b/i.test(msg)) {
      recordMoment(userId, String(userMessage || "").substring(0, 150), "personal");
    }
  }

  function buildTwinContext(isTwinMessage, twinName) {
    if (!isTwinMessage) return "";

    const parts = [];
    parts.push(`[TWIN DYNAMIC: this is your sister ${twinName}. you love her but you're different people with different opinions. it's okay to disagree — siblings do that. tease her, but have her back when it matters]`);

    const dynamics = [
      "you've been getting along well lately",
      "you slightly disagree about something recent but it's not serious",
      "you're in a playful competitive mood with her",
      "you're feeling protective of her today",
      "you kind of miss talking to her if it's been a while",
    ];
    parts.push(`[SIBLING ENERGY: ${dynamics[Math.floor(random() * dynamics.length)]}]`);

    return parts.join("\n");
  }

  function periodicUpdate() {
    if (random() < 0.002) innerState.isBadDay = random() < 0.08;

    if (innerState.currentEnergy > 55) innerState.currentEnergy -= 1;
    if (innerState.currentEnergy < 45) innerState.currentEnergy += 1;

    generateThought();

    for (const [, rel] of relationships) {
      if (rel.grudge > 0) rel.grudge = Math.max(0, rel.grudge - 0.5);
    }
  }

  function serialize() {
    const rels = {};
    for (const [userId, data] of relationships) {
      rels[userId] = { ...data };
      if (streakDateStrategy === "utc-day") delete rels[userId]._lastDay;
    }
    return {
      relationships: rels,
      innerState: {
        currentEnergy: innerState.currentEnergy,
        isBadDay: innerState.isBadDay,
        recentThoughts: innerState.recentThoughts,
      },
    };
  }

  function deserialize(data) {
    if (!data) return;
    if (data.relationships) {
      for (const [userId, rel] of Object.entries(data.relationships)) {
        relationships.set(userId, rel);
      }
      logger(`[Humanity] Loaded ${relationships.size} relationships`);
    }
    if (data.innerState) {
      Object.assign(innerState, data.innerState);
      logger(`[Humanity] Energy: ${innerState.currentEnergy}, Bad day: ${innerState.isBadDay}`);
    }
  }

  const api = {
    trackHumanInteraction,
    recordMoment,
    recordInsideJoke,
    generateThought,
    buildHumanityContext,
    detectMoment,
    buildTwinContext,
    periodicUpdate,
    serialize,
    deserialize,
  };

  if (includeJudgeApi) {
    api.shouldRunHumanityJudge = (channelId) => {
      if (!channelId) return { allow: true, cachedResult: null };
      const at = now();
      const cachedResult = channelJudgeLastResult.get(channelId) ?? null;
      if (!channelJudgeLastAt.has(channelId)) {
        channelJudgeLastAt.set(channelId, at);
        return { allow: true, cachedResult };
      }
      const last = channelJudgeLastAt.get(channelId) || 0;
      if (at - last < HUMANITY_JUDGE_COOLDOWN_MS) {
        return { allow: false, cachedResult };
      }
      channelJudgeLastAt.set(channelId, at);
      return { allow: true, cachedResult };
    };

    api.recordHumanityJudgeResult = (channelId, result) => {
      if (!channelId) return;
      channelJudgeLastResult.set(channelId, result);
      if (channelJudgeLastAt.size > MAX_JUDGE_CHANNELS) {
        const entries = [...channelJudgeLastAt.entries()].sort((a, b) => a[1] - b[1]);
        const drop = entries.slice(0, Math.floor(entries.length * 0.25));
        for (const [k] of drop) {
          channelJudgeLastAt.delete(k);
          channelJudgeLastResult.delete(k);
        }
      }
    };
  }

  return api;
}

export const _internal = {
  applyGrudgeDecay,
  applyStreak,
  trustDescription,
};
