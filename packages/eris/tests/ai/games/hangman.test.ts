import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { createState, applyMove, checkWin, checkLoss, renderWord, renderBoard, DEFAULT_WORD_LIST } from "../../../ai/games/hangman.js";

function playGuesses(word: string, letters: string[]) {
  let s = createState({ word });
  for (const L of letters) {
    const r = applyMove(s, L);
    if (!r.ok) throw new Error(`guess ${L} failed: ${r.reason}`);
    s = r.state;
  }
  return s;
}

describe("hangman.createState", () => {
  it("picks from the default list when no word given", () => {
    const s = createState();
    expect(DEFAULT_WORD_LIST).toContain(s.word);
    expect(s.wrongCount).toBe(0);
    expect(s.guessed.size).toBe(0);
    expect(s.maxWrong).toBe(6);
    expect(s.won).toBe(false);
    expect(s.lost).toBe(false);
  });

  it("accepts a custom word (uppercased)", () => {
    const s = createState({ word: "banana" });
    expect(s.word).toBe("BANANA");
  });

  it("allows spaces and hyphens in the word", () => {
    expect(() => createState({ word: "HELLO WORLD" })).not.toThrow();
    expect(() => createState({ word: "OPEN-SOURCE" })).not.toThrow();
  });

  it("rejects words with numbers or punctuation", () => {
    expect(() => createState({ word: "HELLO1" })).toThrow();
    expect(() => createState({ word: "HI!" })).toThrow();
  });

  it("rejects words with <2 letters", () => {
    expect(() => createState({ word: "A" })).toThrow();
    expect(() => createState({ word: "-" })).toThrow();
  });

  it("uses a deterministic rng when supplied", () => {
    const s1 = createState({ rng: () => 0 });
    const s2 = createState({ rng: () => 0 });
    expect(s1.word).toBe(s2.word);
    expect(s1.word).toBe(DEFAULT_WORD_LIST[0]);
  });
});

describe("hangman.applyMove", () => {
  it("records a correct guess", () => {
    const s = playGuesses("BANANA", ["B"]);
    expect(s.guessed.has("B")).toBe(true);
    expect(s.wrongCount).toBe(0);
  });

  it("records a wrong guess and increments wrongCount", () => {
    const s = playGuesses("BANANA", ["X"]);
    expect(s.guessed.has("X")).toBe(true);
    expect(s.wrongCount).toBe(1);
  });

  it("is idempotent on repeat guesses (no extra wrong)", () => {
    const s1 = playGuesses("APPLE", ["Z"]);
    const s2 = playGuesses("APPLE", ["Z", "Z", "Z"]);
    expect(s1.wrongCount).toBe(1);
    expect(s2.wrongCount).toBe(1);
    expect(s2.guessed.size).toBe(1);
  });

  it("normalizes case", () => {
    const s = playGuesses("APPLE", ["a"]);
    expect(s.guessed.has("A")).toBe(true);
    expect(s.wrongCount).toBe(0);
  });

  it("rejects multi-char guesses", () => {
    const r = applyMove(createState({ word: "APPLE" }), "AB");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_letter");
  });

  it("rejects non-letter guesses", () => {
    const r = applyMove(createState({ word: "APPLE" }), "1");
    expect(r.ok).toBe(false);
  });

  it("rejects empty/null/undefined", () => {
    const s = createState({ word: "APPLE" });
    expect(applyMove(s, "").ok).toBe(false);
    expect(applyMove(s, null as any).ok).toBe(false);
    expect(applyMove(s, undefined as any).ok).toBe(false);
  });
});

describe("hangman.checkWin + checkLoss", () => {
  it("wins when all letters guessed", () => {
    const s = playGuesses("CAT", ["C", "A", "T"]);
    expect(s.won).toBe(true);
    expect(s.lost).toBe(false);
    expect(checkWin(s)).toBe(true);
  });

  it("loses when wrongCount exceeds maxWrong", () => {
    // maxWrong default 6 → 7 wrong letters loses
    const wrong = ["X", "Y", "Z", "Q", "W", "V", "K"];
    const s = playGuesses("CAT", wrong);
    expect(s.wrongCount).toBe(7);
    expect(s.lost).toBe(true);
    expect(s.won).toBe(false);
    expect(checkLoss(s)).toBe(true);
  });

  it("ignores spaces and hyphens in win condition", () => {
    const s = playGuesses("OPEN-SOURCE", ["O", "P", "E", "N", "S", "U", "R", "C"]);
    expect(s.won).toBe(true);
  });

  it("rejects moves after game over", () => {
    const won = playGuesses("CAT", ["C", "A", "T"]);
    const r = applyMove(won, "X");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("game_over");
  });
});

describe("hangman.renderWord + renderBoard", () => {
  it("renders unguessed letters as underscores", () => {
    const s = createState({ word: "CAT" });
    expect(renderWord(s)).toBe("_ _ _");
  });

  it("renders guessed letters in-place", () => {
    const s = playGuesses("CAT", ["C", "T"]);
    expect(renderWord(s)).toBe("C _ T");
  });

  it("preserves spaces and hyphens without needing guesses", () => {
    const s = createState({ word: "ONE-TWO THREE" });
    // Before any guesses — letters are underscores, hyphen/space preserved
    const out = renderWord(s);
    expect(out).toContain("-");
    // Word ONE-TWO THREE renders as: _ _ _ - _ _ _     _ _ _ _ _
    // Count underscores (letters) — should equal letter count (11)
    const underscoreCount = (out.match(/_/g) || []).length;
    expect(underscoreCount).toBe(11);
  });

  it("renderBoard includes the word, guessed set, and stage", () => {
    const s = playGuesses("CAT", ["C"]);
    const out = renderBoard(s);
    expect(out).toContain("C _ _");
    expect(out).toContain("Guessed: C");
    expect(out).toContain("Misses remaining");
  });
});
