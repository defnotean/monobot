// ─── Connect-4 Board Logic ──────────────────────────────────────────────────
// Pure functions, no Discord or I/O — trivially unit-testable.
//
// Board: 7 columns × 6 rows, rendered bottom-up. Pieces drop to the lowest
// empty slot in the chosen column. First to 4-in-a-row (horizontal, vertical,
// or either diagonal) wins. Full board with no winner = draw.
//
// State shape:
//   {
//     cols: Array<Array<Player>>     // 7 cols, each 0–6 entries bottom-up
//     currentPlayer: "X" | "O"
//     winner: "X" | "O" | null
//     draw: boolean
//     moves: number
//     lastMove: { col, row } | null
//   }

const COLS = 7;
const ROWS = 6;

export function createState() {
  return {
    cols: Array.from({ length: COLS }, () => []),
    currentPlayer: "X",
    winner: null,
    draw: false,
    moves: 0,
    lastMove: null,
  };
}

/**
 * Drop a piece for the current player in the given 0-indexed column.
 * Returns { ok, state, reason? }. `state` is a NEW object — caller should replace.
 */
export function applyMove(state, col) {
  if (state.winner || state.draw) {
    return { ok: false, state, reason: "game_over" };
  }
  if (!Number.isInteger(col) || col < 0 || col >= COLS) {
    return { ok: false, state, reason: "invalid_column" };
  }
  if (state.cols[col].length >= ROWS) {
    return { ok: false, state, reason: "column_full" };
  }

  const newCols = state.cols.map((c, i) => (i === col ? [...c, state.currentPlayer] : c));
  const newState = {
    cols: newCols,
    currentPlayer: state.currentPlayer === "X" ? "O" : "X",
    winner: null,
    draw: false,
    moves: state.moves + 1,
    lastMove: { col, row: state.cols[col].length },
  };

  const winner = checkWin(newState);
  if (winner) {
    newState.winner = winner;
    // Currently-queued player DOESN'T get a turn after a win
    newState.currentPlayer = state.currentPlayer;
  } else if (newState.moves >= COLS * ROWS) {
    newState.draw = true;
  }

  return { ok: true, state: newState };
}

/**
 * Check if the last move (or any completed line) has 4-in-a-row.
 * Checked in all 4 axes: horizontal, vertical, NE-diagonal, NW-diagonal.
 */
export function checkWin(state) {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      row.push(state.cols[c][r] ?? null);
    }
    grid.push(row);
  }

  const directions = [
    [0, 1],   // horizontal right
    [1, 0],   // vertical up
    [1, 1],   // NE diagonal
    [1, -1],  // NW diagonal
  ];

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const piece = grid[r][c];
      if (!piece) continue;
      for (const [dr, dc] of directions) {
        let count = 1;
        for (let step = 1; step < 4; step++) {
          const rr = r + dr * step;
          const cc = c + dc * step;
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) break;
          if (grid[rr][cc] !== piece) break;
          count++;
        }
        if (count >= 4) return piece;
      }
    }
  }
  return null;
}

export function checkDraw(state) {
  if (state.winner) return false;
  return state.moves >= COLS * ROWS;
}

/**
 * Render as a Discord-embed-friendly string.
 * Uses unicode circles — red/yellow for X/O, dot for empty — plus a column
 * number header so the player knows which button drops where.
 */
export function renderBoard(state) {
  const pieceX = "🔴";
  const pieceO = "🟡";
  const empty = "⚫";
  const header = "1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣";
  const lines = [header];
  for (let r = ROWS - 1; r >= 0; r--) {
    let line = "";
    for (let c = 0; c < COLS; c++) {
      const v = state.cols[c][r];
      line += v === "X" ? pieceX : v === "O" ? pieceO : empty;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export const CONNECT4_COLS = COLS;
export const CONNECT4_ROWS = ROWS;
