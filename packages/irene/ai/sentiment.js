// ─── Keyword-Based Sentiment Analysis ────────────────────────────────────────
// Returns a score from -1 (very negative) to +1 (very positive).
// Fast and simple — no ML model needed.

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

// ─── Bigram Overrides — Discord-speak two-word phrases ───────────────────────
const BIGRAM_OVERRIDES = new Map([
  ["no cap", 0.3],
  ["on god", 0.3],
  ["fr fr", 0.4],
  ["real talk", 0.2],
  ["lets go", 0.8],
  ["hell yeah", 0.7],
  ["hell no", -0.7],
  ["shut up", -0.6],
  ["no way", -0.3],
  ["not bad", 0.3],
  ["low key", 0.1],
  ["high key", 0.3],
  ["big w", 0.7],
  ["big l", -0.7],
  ["skill issue", -0.5],
  ["touch grass", -0.4],
  ["im dead", 0.5],
  ["so true", 0.4],
  ["go off", 0.4],
  ["stay mad", -0.5],
  ["cry about", -0.5],
  ["cope harder", -0.6],
  ["ratio bozo", -0.8],
  ["its over", -0.6],
  ["we won", 0.7],
  ["good shit", 0.6],
]);

// ─── Emoji Sentiment ─────────────────────────────────────────────────────────
const EMOJI_SENTIMENT = new Map([
  ["\u2764\uFE0F", 0.6], ["\uD83D\uDE02", 0.5], ["\uD83D\uDE0D", 0.6], ["\uD83D\uDE0A", 0.4],
  ["\uD83D\uDE01", 0.4], ["\uD83D\uDE04", 0.4], ["\uD83E\uDD23", 0.5], ["\uD83D\uDE4F", 0.3],
  ["\uD83D\uDD25", 0.5], ["\uD83D\uDCAF", 0.5], ["\uD83C\uDF89", 0.5], ["\uD83E\uDD29", 0.5],
  ["\uD83D\uDE18", 0.4], ["\uD83E\uDD70", 0.5], ["\uD83D\uDC4D", 0.3], ["\uD83D\uDC4F", 0.4],
  ["\uD83D\uDE22", -0.4], ["\uD83D\uDE21", -0.6], ["\uD83D\uDE24", -0.5], ["\uD83D\uDE20", -0.5],
  ["\uD83D\uDE2D", -0.4], ["\uD83E\uDD2E", -0.6], ["\uD83D\uDCA9", -0.4], ["\uD83D\uDC4E", -0.4],
  ["\uD83D\uDE44", -0.3], ["\uD83D\uDE12", -0.3], ["\uD83D\uDE10", -0.1], ["\uD83D\uDC80", -0.2],
  ["\uD83E\uDD21", -0.4], ["\uD83D\uDE31", -0.3], ["\uD83D\uDE14", -0.3], ["\uD83D\uDE29", -0.4],
]);

// ─── Sarcasm Patterns ────────────────────────────────────────────────────────
const SARCASM_PATTERNS = [
  /\boh\s+great\b/i,
  /\bwow\s+thanks\b/i,
  /\byeah\s+sure\b/i,
  /\boh\s+wow\b/i,
  /\bsuuure\b/i,
  /\btotally\b.*\bnot\b/i,
  /\bnice\s+one\b/i,
  /\bvery\s+cool\b.*\bnot\b/i,
  /\boh\s+really\b/i,
  /\byeah\s+right\b/i,
  /\bwhat\s+a\s+surprise\b/i,
  /\bso\s+helpful\b/i,
  /\bgreat\s+job\b.*\b(not|lol|lmao)\b/i,
  /\bimpressive\b.*\bnot\b/i,
  /\b(love|enjoy)\s+that\s+for\s+(me|us)\b/i,
];

export function quickSentiment(text) {
  if (!text || typeof text !== "string") return 0;

  const lower = text.toLowerCase();

  // ── Pass 1: Bigram scan ──────────────────────────────────────────────
  const stripped = lower.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const bigramWords = stripped.split(" ");
  const matchedIndices = new Set();
  let bigramScore = 0;

  for (let i = 0; i < bigramWords.length - 1; i++) {
    const pair = bigramWords[i] + " " + bigramWords[i + 1];
    if (BIGRAM_OVERRIDES.has(pair)) {
      bigramScore += BIGRAM_OVERRIDES.get(pair);
      matchedIndices.add(i);
      matchedIndices.add(i + 1);
    }
  }

  // ── Pass 2: Word-level scan (skip bigram-matched words) ──────────────
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0 && bigramScore === 0) return 0;

  const NEGATORS = new Set(["not", "no", "never", "dont", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "can't", "couldn't", "won't", "wouldn't", "ain't", "barely", "hardly"]);

  let score = bigramScore;
  let intensifier = false;
  let negated = false;

  for (let i = 0; i < words.length; i++) {
    if (matchedIndices.has(i)) continue;
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

  // ── Pass 3: Emoji scan ───────────────────────────────────────────────
  for (const [emoji, value] of EMOJI_SENTIMENT) {
    let idx = text.indexOf(emoji);
    while (idx !== -1) {
      score += value;
      idx = text.indexOf(emoji, idx + emoji.length);
    }
  }

  // Normalize to -1..+1 range based on word count
  // More words dilute the intensity; max impact from short messages
  const normalized = score / Math.max(1, Math.sqrt(words.length));

  // ── Pass 4: Sarcasm check — dampen/invert overly positive scores ────
  let final = Math.max(-1, Math.min(1, normalized));
  if (final > 0.1) {
    for (const pattern of SARCASM_PATTERNS) {
      if (pattern.test(text)) {
        final *= -0.5;
        break;
      }
    }
  }

  return Math.max(-1, Math.min(1, final));
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
