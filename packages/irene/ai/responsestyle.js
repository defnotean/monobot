// ─── Dynamic Response Style Engine ──────────────────────────────────────────
// Makes responses feel human by varying length, effort, and imperfection
// instead of always responding with the same "1-3 sentences" format.

/**
 * Pick a dynamic response style based on current state.
 * Returns a string directive to inject into the system prompt.
 */
export function pickResponseStyle(energy = 50, sentiment = 0, msgLength = 20, trust = 0) {
  const roll = Math.random() * 100;

  // Weights shift based on context
  const isShortMsg = msgLength < 20;
  const isLongMsg = msgLength > 100;
  const isLowEnergy = energy < 30;
  const isHighEnergy = energy > 70;
  const isHighTrust = trust > 40;

  // Ultra-short: "lol" "nah" "ok" — base 35%, +15% for short msgs or low energy
  const ultraShortWeight = 35 + (isShortMsg ? 15 : 0) + (isLowEnergy ? 10 : 0) - (isLongMsg ? 15 : 0);

  // Normal: 1-2 sentences — base 30%
  const normalWeight = 30;

  // Engaged: 2-3 sentences — base 20%, +10% for long msgs or high trust
  const engagedWeight = 20 + (isLongMsg ? 10 : 0) + (isHighTrust ? 5 : 0) - (isShortMsg ? 10 : 0);

  // Burst: 3-5 sentences about something you care about — base 10%
  const burstWeight = 10 + (isHighEnergy ? 5 : 0) + (isHighTrust ? 3 : 0);

  // Minimal: "k" "mhm" — base 5%, +5% for low energy
  const minimalWeight = 5 + (isLowEnergy ? 5 : 0);

  // Normalize and pick
  const total = ultraShortWeight + normalWeight + engagedWeight + burstWeight + minimalWeight;
  const normalized = roll / 100 * total;

  let cursor = 0;
  if (normalized < (cursor += ultraShortWeight)) {
    return "keep it to a few words. 'lol' 'nah' 'ok and?' 'rude' are full responses. you dont need to elaborate on everything";
  }
  if (normalized < (cursor += normalWeight)) {
    return "1-2 sentences. normal energy. match what they gave you";
  }
  if (normalized < (cursor += engagedWeight)) {
    return "you're into this one. 2-3 sentences, show some personality. still texting tho, not writing a blog post";
  }
  if (normalized < (cursor += burstWeight)) {
    return "you actually care about this — go off a bit. 3-5 sentences if you want. break your usual short-response rule, this is worth it. still keep it casual tho";
  }
  return "minimum effort. 'k' 'mhm' 'sure' 'cool'. you're not feeling chatty rn";
}

/**
 * Should the bot give a lazy low-effort response?
 * Returns "lazy" or "normal".
 */
export function shouldLaze(message, energy = 50, trust = 0, isOwner = false) {
  // Never laze for owner, high-trust users, questions, or longer messages
  if (isOwner) return "normal";
  if (trust > 50) return "normal";
  if (/\?/.test(message)) return "normal";
  if (message.length > 40) return "normal"; // Non-trivial messages always get real responses

  // Only laze on truly generic one-word greetings/reactions
  const isGeneric = /^(hey|hi|hello|sup|yo|what's up|lol|lmao|haha|ok|nice|cool|k|mhm|bruh)\s*$/i.test(message.trim());
  if (!isGeneric) return "normal";

  // 10% chance on generic messages when low energy, otherwise skip
  const chance = energy < 30 ? 10 : 3;
  return Math.random() * 100 < chance ? "lazy" : "normal";
}

/**
 * Occasionally suggest a natural imperfection.
 * Returns empty string 85% of the time.
 */
export function getImperfectionHint() {
  if (Math.random() > 0.15) return "";

  const hints = [
    "use 'u' instead of 'you' and 'ur' instead of 'your' this time",
    "skip apostrophes this time — 'dont' 'cant' 'wont'",
    "use 'rn' instead of 'right now' and 'ngl' to start a sentence",
    "type 'idk' instead of 'i don't know' and abbreviate naturally",
    "start your response with 'honestly' or 'ngl'",
    "end with 'but yeah' or 'idk' trailing off",
    "use 'tbh' or 'lowkey' somewhere naturally",
  ];
  return `[NATURAL TYPING: ${hints[Math.floor(Math.random() * hints.length)]}]`;
}
