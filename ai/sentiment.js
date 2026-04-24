// ─── Keyword-Based Sentiment Analysis ────────────────────────────────────────
// Returns a score from -1 (very negative) to +1 (very positive).
// Includes bigram context, emoji sentiment, and basic sarcasm detection.

const POSITIVE = new Set([
  "thanks", "thank", "ty", "thx", "appreciate", "love", "great", "awesome",
  "amazing", "good", "nice", "cool", "perfect", "excellent", "wonderful",
  "beautiful", "fantastic", "incredible", "brilliant", "best", "goat",
  "haha", "hahaha", "lol", "lmao", "lmfao", "rofl", "xd",
  "cute", "adorable", "sweet", "kind", "helpful", "smart", "genius",
  "funny", "hilarious", "legendary", "epic", "fire", "based", "goated",
  "pog", "poggers", "pogchamp", "w", "dub", "clutch", "cracked",
  "respect", "impressed", "proud", "happy", "excited", "hyped",
  "beautiful", "gorgeous", "stunning", "king", "queen", "slay",
  "bless", "blessed", "grateful", "wholesome", "heartwarming",
  "yes", "yay", "yep", "hell yeah", "lets go", "gg",
]);

const NEGATIVE = new Set([
  "hate", "sucks", "terrible", "awful", "stupid", "dumb", "idiot",
  "shut up", "annoying", "boring", "worst", "trash", "garbage",
  "useless", "pointless", "cringe", "ugly", "disgusting", "gross",
  "mad", "angry", "furious", "pissed", "frustrated", "irritated",
  "sad", "depressed", "lonely", "miserable", "pathetic", "lame",
  "bad", "horrible", "atrocious", "abysmal", "disappointing",
  "stfu", "kys", "die", "kill", "toxic", "ratio", "cope",
  "l", "loser", "clown", "mid", "ass", "bruh",
  "broken", "buggy", "glitched", "failed", "ruined",
  "no", "nope", "nah", "hell no", "absolutely not",
  "ugh", "fml", "smh", "yikes",
]);

const INTENSIFIERS = new Set([
  "very", "really", "extremely", "super", "so", "absolutely",
  "totally", "completely", "insanely", "incredibly", "literally",
]);

// ─── Bigram overrides — common Discord phrases where individual words mislead ─
const BIGRAM_OVERRIDES = new Map([
  // Negated negatives → positive
  ["not bad", 0.5],
  ["not terrible", 0.4],
  ["not awful", 0.4],
  ["not horrible", 0.4],
  ["not ugly", 0.3],
  // Negated positives → negative
  ["not good", -0.5],
  ["not great", -0.4],
  ["not cool", -0.4],
  ["not funny", -0.5],
  ["not helpful", -0.4],
  // Discord/internet speak
  ["ngl good", 0.6],
  ["ngl great", 0.7],
  ["ngl bad", -0.6],
  ["kinda mid", -0.3],
  ["lowkey good", 0.4],
  ["lowkey bad", -0.4],
  ["highkey good", 0.7],
  ["fr good", 0.6],
  ["actually good", 0.6],
  ["pretty good", 0.5],
  ["pretty bad", -0.5],
  ["so good", 0.8],
  ["so bad", -0.8],
  ["lets go", 0.7],
  ["im dead", 0.5], // laughter
  ["no way", 0.3],  // usually excitement
  ["go off", 0.5],  // encouraging
]);

// ─── Emoji sentiment map ──────────────────────────────────────────────────
const EMOJI_SENTIMENT = new Map([
  // Positive
  ["❤️", 0.8], ["💕", 0.8], ["💖", 0.8], ["😍", 0.7], ["🥰", 0.7],
  ["😊", 0.5], ["😁", 0.5], ["😄", 0.5], ["🙂", 0.2],
  ["🔥", 0.5], ["💯", 0.6], ["✨", 0.4], ["⭐", 0.4],
  ["👍", 0.4], ["👏", 0.5], ["🎉", 0.6], ["🥳", 0.6],
  ["💀", 0.3], ["☠️", 0.3],  // skull = laughter in Discord
  ["😭", 0.2],               // crying = laughter in Discord context
  ["🤣", 0.5], ["😂", 0.5],
  ["💪", 0.4], ["🫡", 0.3], ["🤝", 0.4],
  ["👑", 0.5], ["🐐", 0.6],
  // Negative
  ["😡", -0.7], ["🤬", -0.8], ["😤", -0.5],
  ["😢", -0.5], ["😞", -0.5], ["😔", -0.4],
  ["🤮", -0.6], ["🤡", -0.3], ["💩", -0.3],
  ["👎", -0.5], ["😒", -0.4], ["🙄", -0.3],
  ["😐", -0.2], ["😑", -0.3],
]);

// ─── Sarcasm hint patterns — conservative, only triggers on clear patterns ──
const SARCASM_PATTERNS = [
  /^oh\s+wow\b/i,
  /^yeah\s+sure\b/i,
  /^sure\s+thing\b/i,
  /^oh\s+great\b/i,
  /^wow\s+thanks\b/i,
  /^real\s+helpful\b/i,
  /^oh\s+how\s+(nice|lovely|wonderful)\b/i,
  /^gee\s+thanks\b/i,
  /^totally\b.*\bnice\b/i,
  /^right\b.*\bbecause\b/i,
];

export function quickSentiment(text) {
  if (!text || typeof text !== "string") return 0;

  const lower = text.toLowerCase();
  const words = lower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 0;

  const NEGATORS = new Set(["not", "no", "never", "dont", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "can't", "couldn't", "won't", "wouldn't", "ain't", "barely", "hardly"]);

  // ─── Pass 1: Bigram overrides (highest priority) ─────────────────
  const bigramSkip = new Set(); // indices to skip in word loop
  let bigramScore = 0;

  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (BIGRAM_OVERRIDES.has(bigram)) {
      bigramScore += BIGRAM_OVERRIDES.get(bigram);
      bigramSkip.add(i);
      bigramSkip.add(i + 1);
    }
    // Also check trigrams (e.g., "ngl good")
    if (i < words.length - 2) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (BIGRAM_OVERRIDES.has(trigram)) {
        bigramScore += BIGRAM_OVERRIDES.get(trigram);
        bigramSkip.add(i);
        bigramSkip.add(i + 1);
        bigramSkip.add(i + 2);
      }
    }
  }

  // ─── Pass 2: Word-level sentiment (skip bigram-matched words) ────
  let score = bigramScore;
  let intensifier = false;
  let negated = false;

  for (let i = 0; i < words.length; i++) {
    if (bigramSkip.has(i)) continue;

    const word = words[i];
    if (NEGATORS.has(word)) {
      negated = true;
      continue;
    }
    if (INTENSIFIERS.has(word)) {
      intensifier = true;
      continue;
    }

    let delta = 0;
    if (POSITIVE.has(word)) delta = 1;
    else if (NEGATIVE.has(word)) delta = -1;

    // "not good" → negative, "not bad" → slightly positive
    if (delta !== 0 && negated) {
      delta *= -0.7;
      negated = false;
    }

    if (delta !== 0 && intensifier) {
      delta *= 1.5;
      intensifier = false;
    }

    score += delta;
    if (delta !== 0) negated = false;
  }

  // ─── Pass 3: Emoji sentiment ─────────────────────────────────────
  for (const [emoji, val] of EMOJI_SENTIMENT) {
    if (text.includes(emoji)) score += val;
  }

  // ─── Pass 4: Sarcasm detection (conservative) ────────────────────
  // Only nudge slightly negative if the text matches sarcasm patterns
  // AND the score is near neutral or slightly positive
  if (score >= -0.2 && score <= 0.8) {
    for (const pattern of SARCASM_PATTERNS) {
      if (pattern.test(lower)) {
        score -= 0.4;
        break; // One sarcasm hit is enough
      }
    }
  }

  // Normalize to -1..+1 range based on word count
  const normalized = score / Math.max(1, Math.sqrt(words.length));

  return Math.max(-1, Math.min(1, normalized));
}

/**
 * Classify interaction style based on message patterns over time.
 * Returns one of: "casual", "technical", "meme-heavy", "chill", "intense"
 */
export function classifyStyle(messages) {
  if (!messages || messages.length < 3) return "casual";

  const combined = messages.join(" ").toLowerCase();
  const codeBlocks = (combined.match(/```/g) || []).length / 2;
  const memeWords = (combined.match(/\b(lol|lmao|bruh|based|cope|ratio|gg|rip|oof|ngl|fr|deadass|lowkey)\b/g) || []).length;
  const techWords = (combined.match(/\b(function|const|let|var|api|server|database|deploy|code|bug|error|git|npm)\b/g) || []).length;

  if (codeBlocks >= 2 || techWords >= 5) return "technical";
  if (memeWords >= 5) return "meme-heavy";
  return "casual";
}
