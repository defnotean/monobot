// ─── Gambling Helpers, Quips, and Game Logic ────────────────────────────────
// Shared by executor.js for all gambling and mini-game tools.

import { log } from "../utils/logger.js";

// ─── Gambling Quips ─────────────────────────────────────────────────────────

export const GAMBLING_QUIPS = [
  "99% of gamblers quit before they win big",
  "the house always wins... except when i feel generous",
  "you miss 100% of the bets you don't take",
  "not financial advice btw",
  "your luck is a statistical anomaly and i respect that",
  "the algorithm giveth and the algorithm taketh away",
  "gamble responsibly (or don't, i'm not your mom)",
  "the coins were merely resting in my account",
  "bold move, let's see if it pays off",
  "mathematically speaking, this was a terrible idea",
  "the odds were never in your favor but here we are",
  "i shuffled extra hard for you",
  "don't tell the regulators about this",
  "my rng is fair i promise (it's not)",
  "the secret is to never stop gambling",
  "one more spin and you'll definitely win (source: trust me)",
  "quitters never prosper, losers never quit",
  "your wallet is crying but your spirit is strong",
  "that's what we in the business call 'getting cooked'",
  "statistically speaking you're due for a win (that's not how statistics work)",
  "i've seen worse decisions... actually no i haven't",
  "you're not addicted you're committed",
  "the only guaranteed way to double your money is to fold it in half",
  "fortune favors the bold (and apparently not you)",
  "i believe in you even when the math doesn't",
  "every coin you lose builds character",
  "think of it as a donation to the chaos fund",
  "this is what peak financial strategy looks like",
  "i'll light a candle for your balance",
  "and they say money can't buy happiness... well it can't buy luck either apparently",
];

// Fallback to a pre-set quip if AI generation fails
export function randomQuipFallback() {
  return GAMBLING_QUIPS[Math.floor(Math.random() * GAMBLING_QUIPS.length)];
}

// ─── Mood-Dependent Gambling Odds ───────────────────────────────────────────
// When Eris is in a good mood, she's slightly more generous.
// When she's pissed, she tilts the odds against you.
//
// The modifier is intentionally small (±3%). Any more than that feels like
// the house is cheating rather than the bot having a personality.

export const MOOD_MAX_ODDS_SHIFT = 0.03; // hard cap on how much mood can move a probability

/**
 * Adjust a base probability based on Eris's current mood.
 * @param {number} baseProb - Base probability (0 to 1)
 * @param {number} moodScore - Current mood score (-100 to 100)
 * @returns {number} Adjusted probability (clamped 0.05 to 0.95)
 */
export function getMoodAdjustedOdds(baseProb, moodScore = 0) {
  // Clamp mood score defensively — we've seen corrupt rows return NaN/strings.
  const safeMood = Math.max(-100, Math.min(100, Number(moodScore) || 0));
  const moodBonus = (safeMood / 100) * MOOD_MAX_ODDS_SHIFT;
  return Math.max(0.05, Math.min(0.95, baseProb + moodBonus));
}

/**
 * Get a mood-flavored prefix for gambling results.
 */
export function getMoodFlavor(moodScore) {
  if (moodScore >= 50) return "i'm feeling generous today so... ";
  if (moodScore >= 20) return "";
  if (moodScore <= -50) return "i'm in a terrible mood so don't expect mercy... ";
  if (moodScore <= -20) return "hmm not feeling great today... ";
  return "";
}

/**
 * Pick a random gambling quip. Uses the pre-set array for speed.
 * (AI-generated quips caused timeouts by making API calls inside API calls)
 *
 * Accepts (and ignores) an optional context object — callers historically
 * passed `{ won, game, amount }` from when quips were AI-generated; the static
 * fallback doesn't need it, but the param keeps those call sites type-clean.
 * @param {{ won?: boolean, game?: string, amount?: number }} [_context]
 */
export function randomQuip(_context) {
  return randomQuipFallback();
}

// ─── Blackjack ──────────────────────────────────────────────────────────────

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function cardString(card) {
  return `${card.rank}${card.suit}`;
}

export function handString(hand) {
  return hand.map(cardString).join(" ");
}

export function handValue(hand) {
  let value = 0;
  let aces = 0;
  for (const card of hand) {
    if (!card || !card.rank) continue; // Safety: skip undefined cards (deck underflow)
    if (card.rank === "A") {
      aces++;
      value += 11;
    } else if (["K", "Q", "J"].includes(card.rank)) {
      value += 10;
    } else {
      value += parseInt(card.rank);
    }
  }
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return value;
}

export function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

// ─── Slots ──────────────────────────────────────────────────────────────────
// Eris has FULL control: she can add/remove symbols, tweak weights,
// change tiers, customize messages — the machine is HERS.
// Default config loaded here, but she can override via configure_slots tool.

let _slotsConfig = null; // Loaded from DB, overrides defaults if set

export let SLOT_SYMBOLS = [
  // JUNK tier — most common, never pays on pairs
  { emoji: "🍒", name: "cherry",   weight: 14, tier: "junk" },
  { emoji: "🍋", name: "lemon",    weight: 14, tier: "junk" },
  { emoji: "🍊", name: "orange",   weight: 12, tier: "junk" },
  { emoji: "🍇", name: "grape",    weight: 10, tier: "junk" },
  { emoji: "🍉", name: "melon",    weight: 8,  tier: "junk" },
  { emoji: "🥝", name: "kiwi",     weight: 7,  tier: "junk" },
  // COMMON tier — small payouts on pairs
  { emoji: "🔔", name: "bell",     weight: 7,  tier: "common" },
  { emoji: "⭐", name: "star",     weight: 6,  tier: "common" },
  { emoji: "🎵", name: "music",    weight: 5,  tier: "common" },
  // RARE tier — good payouts
  { emoji: "💎", name: "diamond",  weight: 4,  tier: "rare" },
  { emoji: "👑", name: "crown",    weight: 3,  tier: "rare" },
  { emoji: "🔥", name: "fire",     weight: 3,  tier: "rare" },
  // LEGENDARY tier — jackpots
  { emoji: "7️⃣",  name: "seven",    weight: 2,  tier: "legendary" },
  { emoji: "🌟", name: "supernova",weight: 1,  tier: "legendary" },
  // SKULL — instant loss
  { emoji: "💀", name: "skull",    weight: 4,  tier: "skull" },
];

function weightedPick(symbols) {
  const totalWeight = symbols.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const s of symbols) { roll -= s.weight; if (roll <= 0) return s; }
  return symbols[0];
}

/**
 * Spin slots with optional rigging based on Eris's mood and her
 * feelings about the user. She doesn't always rig — only when she FEELS like it.
 * Rig chance is controlled by _gameConfig.global.rigChance (default 10%) and
 * can be disabled entirely via _gameConfig.global.moodRigEnabled = false.
 * The negative nudge forces "no match" rather than inserting a skull, so the
 * worst-case mood penalty is losing the stake, not losing double.
 * @param {number} moodScore - Eris's current mood (-100 to 100)
 * @param {number} affinity - Her affinity with this user (-100 to 100)
 */
export function spinSlots(moodScore = 0, affinity = 0) {
  let reels = [weightedPick(SLOT_SYMBOLS), weightedPick(SLOT_SYMBOLS), weightedPick(SLOT_SYMBOLS)];

  // ── Rigging logic — Eris's personal touch ──
  const global = _gameConfig.global || {};
  if (!global.moodRigEnabled) return reels;
  const rigChance = typeof global.rigChance === "number" ? global.rigChance : 0.10;
  if (Math.random() > rigChance) return reels;

  // In a GREAT mood + likes the user → nudge toward a win
  if (moodScore > 30 && affinity > 30 && Math.random() < 0.5) {
    // Force a pair of something decent
    const good = SLOT_SYMBOLS.filter(s => s.tier === "common" || s.tier === "rare");
    const pick = good[Math.floor(Math.random() * good.length)];
    reels[Math.random() < 0.5 ? 0 : 1] = pick;
    reels[Math.random() < 0.5 ? 1 : 2] = pick;
    return reels;
  }

  // In a BAD mood or dislikes the user → nudge toward a loss (but not a
  // double-loss skull). Force three different non-skull symbols so the player
  // just gets "no match" — the most common fair outcome anyway.
  if (moodScore < -20 || affinity < -10) {
    const noSkull = SLOT_SYMBOLS.filter(s => s.tier !== "skull");
    const picked = new Set();
    reels = reels.map(() => {
      let sym;
      do { sym = noSkull[Math.floor(Math.random() * noSkull.length)]; } while (picked.has(sym.name));
      picked.add(sym.name);
      return sym;
    });
    return reels;
  }

  // Feeling chaotic → force all different (no match, no skull — just frustrating)
  if (Math.abs(moodScore) < 10 && Math.random() < 0.3) {
    const noSkull = SLOT_SYMBOLS.filter(s => s.tier !== "skull");
    const picked = new Set();
    reels = reels.map(() => {
      let sym;
      do { sym = noSkull[Math.floor(Math.random() * noSkull.length)]; } while (picked.has(sym.name));
      picked.add(sym.name);
      return sym;
    });
  }

  return reels;
}

export function slotsDisplay(reels) {
  return `[ ${reels.map((r) => r.emoji).join(" | ")} ]`;
}

export function slotsPayout(reels) {
  const names = reels.map((r) => r.name);
  const tiers = reels.map((r) => r.tier);

  // All skulls = double loss
  if (names.every(n => n === "skull")) return { multiplier: -2, label: "💀💀💀 DEATH JACKPOT — you lose DOUBLE", rigged: false };

  // Any skull = instant loss
  if (names.includes("skull")) return { multiplier: 0, label: "💀 skull appeared... you lose", rigged: false };

  // Three of a kind
  if (names[0] === names[1] && names[1] === names[2]) {
    if (names[0] === "supernova") return { multiplier: 100, label: "🌟🌟🌟 SUPERNOVA JACKPOT!!!" };
    if (names[0] === "seven") return { multiplier: 50, label: "7️⃣7️⃣7️⃣ TRIPLE SEVENS JACKPOT" };
    if (names[0] === "crown") return { multiplier: 30, label: "👑👑👑 TRIPLE CROWNS" };
    if (names[0] === "diamond") return { multiplier: 25, label: "💎💎💎 TRIPLE DIAMONDS" };
    if (names[0] === "fire") return { multiplier: 20, label: "🔥🔥🔥 TRIPLE FIRE" };
    if (tiers[0] === "common") return { multiplier: 12, label: `TRIPLE ${names[0].toUpperCase()}S` };
    return { multiplier: 8, label: `TRIPLE ${names[0].toUpperCase()}S` };
  }

  // Two of a kind — only valuable symbols pay
  if (names[0] === names[1] || names[1] === names[2] || names[0] === names[2]) {
    const pairName = names[0] === names[1] ? names[0] : names[0] === names[2] ? names[0] : names[1];
    const pairTier = reels.find(r => r.name === pairName)?.tier;
    if (pairTier === "legendary") return { multiplier: 5, label: `pair of ${pairName}s` };
    if (pairTier === "rare") return { multiplier: 3, label: `pair of ${pairName}s` };
    if (pairTier === "common") return { multiplier: 1.5, label: `pair of ${pairName}s` };
    // Junk pairs = push (get money back)
    return { multiplier: 1, label: `pair of ${pairName}s (push)` };
  }

  // No match
  return { multiplier: 0, label: "no match" };
}

// ─── Slot Machine Configuration (Eris's full control) ────────────────

/**
 * Eris can dynamically configure the slot machine:
 * - Add/remove symbols
 * - Change weights (probability)
 * - Change tiers (affects payout)
 * - Override payout messages
 * All changes persist to Supabase.
 */
export function getSlotsConfig() {
  return { symbols: SLOT_SYMBOLS, rigChance: 0.20 };
}

export function addSlotSymbol(emoji, name, weight, tier) {
  if (SLOT_SYMBOLS.find(s => s.name === name)) return `symbol "${name}" already exists — use tweakSlotSymbol to modify it`;
  SLOT_SYMBOLS.push({ emoji, name, weight: Math.max(1, Math.min(50, weight)), tier: tier || "junk" });
  _saveSlotsConfig();
  return `added ${emoji} ${name} (weight: ${weight}, tier: ${tier})`;
}

export function removeSlotSymbol(name) {
  const idx = SLOT_SYMBOLS.findIndex(s => s.name === name);
  if (idx === -1) return `symbol "${name}" not found`;
  if (SLOT_SYMBOLS.length <= 5) return "can't remove — need at least 5 symbols";
  const removed = SLOT_SYMBOLS.splice(idx, 1)[0];
  _saveSlotsConfig();
  return `removed ${removed.emoji} ${removed.name}`;
}

export function tweakSlotSymbol(name, changes) {
  const sym = SLOT_SYMBOLS.find(s => s.name === name);
  if (!sym) return `symbol "${name}" not found`;
  if (changes.weight !== undefined) sym.weight = Math.max(1, Math.min(50, changes.weight));
  if (changes.tier) sym.tier = changes.tier;
  if (changes.emoji) sym.emoji = changes.emoji;
  _saveSlotsConfig();
  return `updated ${sym.emoji} ${sym.name}: weight=${sym.weight}, tier=${sym.tier}`;
}

export function listSlotSymbols() {
  const totalWeight = SLOT_SYMBOLS.reduce((s, sym) => s + sym.weight, 0);
  return SLOT_SYMBOLS.map(s =>
    `${s.emoji} ${s.name} — weight: ${s.weight} (${(s.weight / totalWeight * 100).toFixed(1)}%), tier: ${s.tier}`
  ).join("\n");
}

async function _saveSlotsConfig() {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (sb) await sb.from("bot_data").upsert({ id: "eris_slots_config", data: { symbols: SLOT_SYMBOLS } });
  } catch (e) {
    log(`[GAMBLING] save slots config failed: ${e.message}`);
  }
}

// Load custom config on startup
(async () => {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return;
    const { data: row } = await sb.from("bot_data").select("data").eq("id", "eris_slots_config").single();
    const symbols = row?.data?.symbols;
    if (Array.isArray(symbols) && symbols.length >= 5) {
      SLOT_SYMBOLS.length = 0;
      SLOT_SYMBOLS.push(...symbols);
    }
  } catch (e) {
    log(`[GAMBLING] load slots config failed: ${e.message}`);
  }
})();

// ─── Universal Game Configuration ──────────────────────────────────────────
// Eris has FULL control over every game's odds, payouts, and behavior.

const _defaultGameConfig = {
  coinflip: { baseOdds: 0.5, moodInfluence: MOOD_MAX_ODDS_SHIFT, minBet: 1 },
  dice: { payout: 4, faces: 6, minBet: 1 },
  blackjack: { dealerStandsOn: 17, naturalPayout: 1.5, minBet: 1 },
  roulette: { deathChance: 1/6, surviveMultiplier: 0.5, minBet: 1 },
  rps: { botBias: null, minBet: 0 }, // null = fair, "rock"/"paper"/"scissors" = biased
  trivia: { easyMultiplier: 1.5, mediumMultiplier: 2, hardMultiplier: 3 },
  // rigChance: only 10% of spins are mood-influenced — the rest are fully fair.
  global: { rigChance: 0.10, moodRigEnabled: true },
};

let _gameConfig = JSON.parse(JSON.stringify(_defaultGameConfig));

export function getGameConfig(game) {
  return _gameConfig[game] || null;
}

export function setGameConfig(game, setting, value) {
  if (!_gameConfig[game]) return `unknown game: ${game}`;
  if (_gameConfig[game][setting] === undefined) return `unknown setting "${setting}" for ${game}. available: ${Object.keys(_gameConfig[game]).join(", ")}`;
  _gameConfig[game][setting] = value;
  _saveGameConfig();
  return `${game}.${setting} = ${value}`;
}

export function listGameConfig() {
  const lines = [];
  for (const [game, settings] of Object.entries(_gameConfig)) {
    lines.push(`**${game}:**`);
    for (const [key, val] of Object.entries(settings)) {
      const def = _defaultGameConfig[game]?.[key];
      const changed = JSON.stringify(val) !== JSON.stringify(def);
      lines.push(`  ${key}: ${val}${changed ? " *(modified)*" : ""}`);
    }
  }
  return lines.join("\n");
}

export function resetGameConfig(game) {
  if (game === "all") {
    _gameConfig = JSON.parse(JSON.stringify(_defaultGameConfig));
    _saveGameConfig();
    return "all game configs reset to defaults";
  }
  if (!_defaultGameConfig[game]) return `unknown game: ${game}`;
  _gameConfig[game] = JSON.parse(JSON.stringify(_defaultGameConfig[game]));
  _saveGameConfig();
  return `${game} config reset to defaults`;
}

async function _saveGameConfig() {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (sb) await sb.from("bot_data").upsert({ id: "eris_game_config", data: _gameConfig });
  } catch (e) {
    log(`[GAMBLING] save game config failed: ${e.message}`);
  }
}

// Load custom config on startup
(async () => {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return;
    const { data: row } = await sb.from("bot_data").select("data").eq("id", "eris_game_config").single();
    if (row?.data) {
      for (const [game, settings] of Object.entries(row.data)) {
        if (_gameConfig[game]) Object.assign(_gameConfig[game], settings);
      }
    }
  } catch (e) {
    log(`[GAMBLING] load game config failed: ${e.message}`);
  }
})();

// ─── Fortune Telling ────────────────────────────────────────────────────────

export const FORTUNE_RESPONSES = [
  // Positive
  "the stars say yes and honestly who am i to argue",
  "absolutely, the vibes are immaculate",
  "100% yes, i'd bet coins on it (and you know how i feel about gambling)",
  "the universe literally just gave you a thumbs up",
  "yes but only because i like you",
  "signs point to yes and i pointed the signs",
  "it's giving main character energy, so yes",
  "the algorithm has spoken: favorable outcome detected",
  // Neutral / Cryptic
  "ask again when mercury isn't in retrograde (it's always in retrograde)",
  "the answer is hidden in the sauce",
  "maybe, but only on a tuesday",
  "i could tell you but then i'd have to curse you",
  "the spirits are arguing about it give them a minute",
  "unclear, try bribing me with compliments",
  "the answer exists in a quantum superposition of yes and no",
  "i know the answer but it's funnier if i don't tell you",
  "the prophecy is loading... buffering... buffering...",
  // Negative
  "lmaooo no",
  "the stars say no and they're laughing about it",
  "absolutely not and i'm concerned you even asked",
  "not in this timeline bestie",
  "outlook not so good (that's both my prediction and your future)",
  "the spirits checked and said 'nah fam'",
  "no and the universe wants you to know it's not personal (it totally is)",
  "i pulled a card and it was just a picture of a clown (you)",
  "hard no, would you like a tissue",
  // Ominous
  "something wicked this way comes... and it's your decision-making skills",
  "i see great change in your future (i changed my mind about helping you)",
  "the void stares back and it looks unimpressed",
  "fate has plans for you... mostly chaotic ones",
  "i foresee consequences... delicious, entertaining consequences",
  "the prophecy speaks of one who will ask a silly question... oh wait that's you",
  "your destiny is written in the stars but the handwriting is terrible",
];

export function randomFortune() {
  return FORTUNE_RESPONSES[Math.floor(Math.random() * FORTUNE_RESPONSES.length)];
}

// ─── Curse Effects ──────────────────────────────────────────────────────────

export const CURSE_NICKNAMES = [
  "certified clown 🤡",
  "professional L collector",
  "eris's favorite victim",
  "biggest loser in the server",
  "down bad and everyone knows",
  "bot food",
  "touched grass once (allergic reaction)",
  "NPC energy",
  "main character (derogatory)",
  "skill issue personified",
  "my emotional support punching bag",
  "temporarily embarrassed millionaire",
  "the weakest link",
  "loading screen enthusiast",
  "ctrl+L champion",
  "copium addict",
  "AFK in real life",
  "bug not feature",
  "error 404: dignity not found",
  "RNG's least favorite child",
];

export function randomCurseNickname() {
  return CURSE_NICKNAMES[Math.floor(Math.random() * CURSE_NICKNAMES.length)];
}

// ─── Word Scramble ──────────────────────────────────────────────────────────

export const WORD_LIST = [
  "algorithm", "database", "function", "variable", "boolean", "compile",
  "runtime", "syntax", "framework", "deploy", "server", "client",
  "discord", "stream", "gaming", "keyboard", "monitor", "pixel",
  "render", "buffer", "socket", "packet", "binary", "kernel",
  "thread", "cache", "debug", "script", "module", "import",
  "export", "async", "promise", "callback", "closure", "scope",
  "banana", "potato", "pizza", "coffee", "chaos", "galaxy",
  "wizard", "dragon", "knight", "castle", "quest", "dungeon",
  "potion", "sword", "shield", "magic", "crystal", "shadow",
  "thunder", "lightning", "storm", "frost", "flame", "ember",
  "phantom", "legend", "cosmic", "nebula", "stellar", "quantum",
  "glitch", "matrix", "cipher", "enigma", "riddle", "puzzle",
  "goblin", "troll", "ogre", "demon", "angel", "spirit",
  "zombie", "vampire", "werewolf", "ghost", "skeleton", "witch",
  "pirate", "ninja", "samurai", "viking", "spartan", "gladiator",
  "rocket", "satellite", "asteroid", "comet", "eclipse", "gravity",
];

export function scrambleWord(word) {
  const chars = word.split("");
  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  // Make sure it's actually scrambled
  const scrambled = chars.join("");
  if (scrambled === word) return scrambleWord(word); // re-scramble if identical
  return scrambled;
}

export function pickRandomWord() {
  return WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
}

// ─── Trivia Category Mapping (OpenTDB API) ─────────────────────────────────

export const TRIVIA_CATEGORIES = {
  general: 9,
  science: 17,
  gaming: 15,
  anime: 31,
  movies: 11,
  history: 23,
  music: 12,
  sports: 21,
  geography: 22,
  computers: 18,
  math: 19,
  mythology: 20,
};

// ─── Random Event Types ─────────────────────────────────────────────────────

export const RANDOM_EVENTS = [
  {
    type: "coin_drop",
    message: "oops i dropped some coins... first person to say 'mine' gets them",
    reward: () => 50 + Math.floor(Math.random() * 150), // 50-200 coins
  },
  {
    type: "double_or_nothing",
    message: "DOUBLE OR NOTHING HOUR — next bet anyone makes in the next 5 minutes pays double",
    duration: 300_000, // 5 minutes
  },
  {
    type: "tax_collection",
    message: "the chaos tax collector has arrived... everyone in this channel loses 10 coins",
    penalty: 10,
  },
  {
    type: "lucky_number",
    message: "i'm thinking of a number between 1 and 10... first person to guess it wins 100 coins",
    reward: 100,
  },
  {
    type: "reverse_day",
    message: "REVERSE DAY — for the next 5 minutes, losing a bet means you WIN and winning means you LOSE",
    duration: 300_000,
  },
  {
    type: "mystery_box",
    message: "mystery box appeared! say 'open' to claim it... could be coins, could be a curse",
  },
];

export function pickRandomEvent() {
  return RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)];
}
