import { describe, it, expect } from "vitest";

// @ts-expect-error — JS module
import { createState, applyMove, checkWin, checkDraw, renderBoard } from "../../../ai/games/tictactoe.js";

function playSeq(indices: number[]) {
  let s = createState();
  for (const i of indices) {
    const r = applyMove(s, i);
    if (!r.ok) throw new Error(`move ${i} failed: ${r.reason}`);
    s = r.state;
  }
  return s;
}

describe("tictactoe.createState", () => {
  it("starts empty with X to move", () => {
    const s = createState();
    expect(s.cells).toHaveLength(9);
    expect(s.cells.every((c: any) => c === null)).toBe(true);
    expect(s.currentPlayer).toBe("X");
    expect(s.winner).toBeNull();
    expect(s.draw).toBe(false);
    expect(s.moves).toBe(0);
  });
});

describe("tictactoe.applyMove", () => {
  it("places X at the given cell", () => {
    const r = applyMove(createState(), 4);
    expect(r.ok).toBe(true);
    expect(r.state.cells[4]).toBe("X");
    expect(r.state.currentPlayer).toBe("O");
  });

  it("rejects occupied cells", () => {
    const s = playSeq([0]);
    const r = applyMove(s, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cell_taken");
  });

  it("rejects out-of-bounds indices", () => {
    const s = createState();
    expect(applyMove(s, -1).ok).toBe(false);
    expect(applyMove(s, 9).ok).toBe(false);
    expect(applyMove(s, 1.5).ok).toBe(false);
    expect(applyMove(s, null as any).ok).toBe(false);
  });
});

describe("tictactoe.checkWin", () => {
  it("detects top row", () => {
    //  X X X
    //  O O .
    //  . . .
    const s = playSeq([0, 3, 1, 4, 2]);
    expect(s.winner).toBe("X");
    expect(s.winLine).toEqual([0, 1, 2]);
  });

  it("detects middle column", () => {
    const s = playSeq([1, 0, 4, 2, 7]);
    expect(s.winner).toBe("X");
    expect(s.winLine).toEqual([1, 4, 7]);
  });

  it("detects main diagonal", () => {
    const s = playSeq([0, 1, 4, 2, 8]);
    expect(s.winner).toBe("X");
    expect(s.winLine).toEqual([0, 4, 8]);
  });

  it("detects anti-diagonal", () => {
    const s = playSeq([2, 0, 4, 1, 6]);
    expect(s.winner).toBe("X");
    expect(s.winLine).toEqual([2, 4, 6]);
  });

  it("returns null with no win", () => {
    expect(checkWin(createState())).toBeNull();
    expect(checkWin(playSeq([0, 1]))).toBeNull();
  });
});

describe("tictactoe.checkDraw", () => {
  it("detects full-board draw with no winner", () => {
    // X O X
    // X O O
    // O X X
    // Move sequence that reaches this: 0(X) 1(O) 2(X) 4(O) 3(X) 5(O) 7(X)? ...
    // Simpler: build state manually and call checkDraw.
    const s = {
      cells: ["X", "O", "X", "X", "O", "O", "O", "X", "X"],
      currentPlayer: "X",
      winner: null,
      draw: false,
      moves: 9,
      winLine: null,
    };
    expect(checkDraw(s)).toBe(true);
  });

  it("is false with a winner", () => {
    expect(checkDraw({ winner: "X", moves: 9 } as any)).toBe(false);
  });

  it("is false before full", () => {
    expect(checkDraw(playSeq([0]))).toBe(false);
  });
});

describe("tictactoe.renderBoard", () => {
  it("renders 3 lines", () => {
    expect(renderBoard(createState()).split("\n")).toHaveLength(3);
  });

  it("shows placed pieces", () => {
    const s = playSeq([0, 4]);
    const out = renderBoard(s);
    expect(out).toContain("❌");
    expect(out).toContain("⭕");
  });
});
