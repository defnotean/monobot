// ─── Tic-Tac-Toe Board Logic ────────────────────────────────────────────────
// Pure, no Discord. 3×3 grid, X first.
//
// State:
//   {
//     cells: Array<9, "X" | "O" | null>  // row-major
//     currentPlayer: "X" | "O"
//     winner: "X" | "O" | null
//     draw: boolean
//     moves: number
//     winLine: number[] | null  // indices of the winning 3-in-a-row
//   }

const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],             // diagonals
];

export function createState() {
  return {
    cells: Array(9).fill(null),
    currentPlayer: "X",
    winner: null,
    draw: false,
    moves: 0,
    winLine: null,
  };
}

export function applyMove(state, index) {
  if (state.winner || state.draw) {
    return { ok: false, state, reason: "game_over" };
  }
  if (!Number.isInteger(index) || index < 0 || index >= 9) {
    return { ok: false, state, reason: "invalid_cell" };
  }
  if (state.cells[index] !== null) {
    return { ok: false, state, reason: "cell_taken" };
  }

  const cells = state.cells.slice();
  cells[index] = state.currentPlayer;
  const newState = {
    cells,
    currentPlayer: state.currentPlayer === "X" ? "O" : "X",
    winner: null,
    draw: false,
    moves: state.moves + 1,
    winLine: null,
  };

  const win = checkWin(newState);
  if (win) {
    newState.winner = win.player;
    newState.winLine = win.line;
    newState.currentPlayer = state.currentPlayer;
  } else if (newState.moves >= 9) {
    newState.draw = true;
  }

  return { ok: true, state: newState };
}

export function checkWin(state) {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    const v = state.cells[a];
    if (v && state.cells[b] === v && state.cells[c] === v) {
      return { player: v, line };
    }
  }
  return null;
}

export function checkDraw(state) {
  if (state.winner) return false;
  return state.moves >= 9;
}

export function renderBoard(state) {
  const symX = "❌";
  const symO = "⭕";
  const empty = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const v = state.cells[i];
      row.push(v === "X" ? symX : v === "O" ? symO : empty[i]);
    }
    rows.push(row.join(""));
  }
  return rows.join("\n");
}
