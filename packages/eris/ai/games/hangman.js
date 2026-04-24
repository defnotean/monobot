// ─── Hangman Game Logic ─────────────────────────────────────────────────────
// Pure — no Discord. Single-player vs the word list.
//
// State:
//   {
//     word: string              // the target (uppercase, letters + optional spaces/hyphens)
//     guessed: Set<string>      // letters the player has tried (uppercase)
//     wrongCount: number        // count of guessed letters not in word
//     maxWrong: number          // default 6
//     won: boolean
//     lost: boolean
//   }
//
// Win: all letters of `word` appear in `guessed`.
// Loss: wrongCount > maxWrong.

const DEFAULT_MAX_WRONG = 6;

const DEFAULT_WORD_LIST = [
  "DISCORD", "JAVASCRIPT", "NODEJS", "MONOREPO", "REPOSITORY",
  "KEYBOARD", "MOUSE", "MONITOR", "CABLE", "POWER",
  "WIZARD", "DRAGON", "CASTLE", "FOREST", "OCEAN",
  "SANDWICH", "PIZZA", "COFFEE", "DONUT", "SALAD",
  "PLANET", "GALAXY", "ASTEROID", "COMET", "NEBULA",
  "GUITAR", "PIANO", "VIOLIN", "DRUMS", "TRUMPET",
  "PYTHON", "TYPESCRIPT", "RUST", "GOLANG", "JAVA",
  "BANANA", "APPLE", "ORANGE", "GRAPE", "MANGO",
  "ELEPHANT", "GIRAFFE", "KANGAROO", "PENGUIN", "DOLPHIN",
  "MOUNTAIN", "VALLEY", "RIVER", "DESERT", "VOLCANO",
];

export function createState({ word, maxWrong = DEFAULT_MAX_WRONG, rng = Math.random } = {}) {
  const chosen = word
    ? String(word).toUpperCase()
    : DEFAULT_WORD_LIST[Math.floor(rng() * DEFAULT_WORD_LIST.length)];

  // Validate: letters, spaces, hyphens only
  if (!/^[A-Z\s-]+$/.test(chosen)) {
    throw new Error("Hangman word must contain only letters, spaces, and hyphens");
  }
  if (chosen.replace(/[^A-Z]/g, "").length < 2) {
    throw new Error("Hangman word must have at least 2 letters");
  }

  return {
    word: chosen,
    guessed: new Set(),
    wrongCount: 0,
    maxWrong,
    won: false,
    lost: false,
  };
}

/**
 * Apply a letter guess. `letter` should be a single A-Z (case-insensitive).
 * Idempotent: guessing a letter twice is a no-op (no extra wrong count, no
 * state change).
 * Returns { ok, state, correct?, alreadyGuessed?, reason? }.
 */
export function applyMove(state, letter) {
  if (state.won || state.lost) {
    return { ok: false, state, reason: "game_over" };
  }
  if (typeof letter !== "string") {
    return { ok: false, state, reason: "invalid_letter" };
  }
  const L = letter.toUpperCase().trim();
  if (!/^[A-Z]$/.test(L)) {
    return { ok: false, state, reason: "invalid_letter" };
  }
  if (state.guessed.has(L)) {
    return { ok: true, state, alreadyGuessed: true };
  }

  const newGuessed = new Set(state.guessed);
  newGuessed.add(L);
  const correct = state.word.includes(L);
  const wrongCount = state.wrongCount + (correct ? 0 : 1);

  // Check win: every letter of word is in newGuessed (ignore spaces/hyphens)
  const wordLetters = new Set(state.word.replace(/[^A-Z]/g, ""));
  let won = true;
  for (const w of wordLetters) {
    if (!newGuessed.has(w)) {
      won = false;
      break;
    }
  }
  const lost = !won && wrongCount > state.maxWrong;

  return {
    ok: true,
    correct,
    state: {
      ...state,
      guessed: newGuessed,
      wrongCount,
      won,
      lost,
    },
  };
}

export function checkWin(state) { return state.won; }
export function checkLoss(state) { return state.lost; }

/**
 * Render the word with unknown letters as underscores.
 * "HELLO WORLD" with [H, L, O] guessed → "H _ L L O   _ O _ L _"
 */
export function renderWord(state) {
  return state.word
    .split("")
    .map((ch) => {
      if (ch === " ") return "  ";
      if (ch === "-") return "-";
      return state.guessed.has(ch) ? ch : "_";
    })
    .join(" ");
}

export function renderBoard(state) {
  const hangmanStages = [
    "```\n  _____\n  |   |\n      |\n      |\n      |\n      |\n=========```",
    "```\n  _____\n  |   |\n  O   |\n      |\n      |\n      |\n=========```",
    "```\n  _____\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```",
    "```\n  _____\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```",
    "```\n  _____\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```",
    "```\n  _____\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```",
    "```\n  _____\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```",
  ];
  const stage = Math.min(state.wrongCount, hangmanStages.length - 1);
  const word = renderWord(state);
  const guessed = state.guessed.size > 0
    ? `Guessed: ${[...state.guessed].sort().join(" ")}`
    : "No guesses yet.";
  const remaining = state.maxWrong - state.wrongCount + 1;
  return `${hangmanStages[stage]}\n**${word}**\n${guessed}\nMisses remaining: ${Math.max(0, remaining)}`;
}

export { DEFAULT_WORD_LIST };
