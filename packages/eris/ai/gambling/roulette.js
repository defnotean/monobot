// ─── European Roulette Logic ────────────────────────────────────────────────
// Pure functions, no Discord or DB. Single 0 (no double-zero — that's American
// and gives the house a worse-for-player 5.26% edge instead of European's 2.7%).
//
// Wheel: numbers 0–36. Reds: 1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36.
// 0 is green and loses every "outside" bet (red/black, even/odd, low/high,
// dozen, column). Only `straight` bets on 0 itself can hit when 0 spins.
//
// Bet types and payouts (multiplier ON winnings, not including stake refund):
//   straight    — pick a single number 0–36          → 35:1
//   red / black — color bet                          → 1:1
//   even / odd  — parity (0 is neither)              → 1:1
//   low / high  — 1–18 / 19–36                       → 1:1
//   dozen_1     — 1–12                               → 2:1
//   dozen_2     — 13–24                              → 2:1
//   dozen_3     — 25–36                              → 2:1
//   column_1    — 1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34 → 2:1
//   column_2    — 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35 → 2:1
//   column_3    — 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36 → 2:1
//
// On win, the player gets back stake + (stake * multiplier).
// On loss, the stake is lost.

export const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const BLACK_NUMBERS = new Set([
  2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
]);

export const BET_TYPES = [
  "straight", "red", "black", "even", "odd", "low", "high",
  "dozen_1", "dozen_2", "dozen_3",
  "column_1", "column_2", "column_3",
];

const PAYOUT_MULTIPLIER = {
  straight: 35,
  red: 1, black: 1,
  even: 1, odd: 1,
  low: 1, high: 1,
  dozen_1: 2, dozen_2: 2, dozen_3: 2,
  column_1: 2, column_2: 2, column_3: 2,
};

/**
 * Spin the wheel — uniform random integer in [0, 36].
 * @param {() => number} [rng] - optional injected rng for testing
 */
export function spin(rng = Math.random) {
  return Math.floor(rng() * 37);
}

/**
 * Look up the color of a number. Returns "red" | "black" | "green" (only 0 is green).
 */
export function colorOf(n) {
  if (n === 0) return "green";
  if (RED_NUMBERS.has(n)) return "red";
  if (BLACK_NUMBERS.has(n)) return "black";
  throw new Error(`Invalid roulette number: ${n}`);
}

/**
 * Validate a bet shape. Returns { ok, reason? }.
 * - type must be a known bet type
 * - amount must be a positive finite integer
 * - for straight, number must be 0–36
 * - for non-straight, number is ignored
 *
 * @param {{ type?: string, amount?: number, number?: number }} [bet]
 */
export function validateBet({ type, amount, number } = {}) {
  if (typeof type !== "string" || !BET_TYPES.includes(type)) return { ok: false, reason: "invalid_type" };
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (type === "straight") {
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > 36) {
      return { ok: false, reason: "invalid_number" };
    }
  }
  return { ok: true };
}

/**
 * Resolve a bet against a spin result.
 * Returns { won: boolean, payout: number } where:
 *   - payout is the TOTAL the player receives back (stake + winnings) on win
 *   - payout is 0 on loss
 */
export function resolveBet({ type, amount, number }, spunNumber) {
  const v = validateBet({ type, amount, number });
  if (!v.ok) throw new Error(`invalid bet: ${v.reason}`);
  if (!Number.isInteger(spunNumber) || spunNumber < 0 || spunNumber > 36) {
    throw new Error(`invalid spunNumber: ${spunNumber}`);
  }

  const won = isHit(type, spunNumber, number);
  if (!won) return { won: false, payout: 0 };

  const multiplier = PAYOUT_MULTIPLIER[type];
  const winnings = amount * multiplier;
  return { won: true, payout: amount + winnings };
}

function isHit(type, spun, betNumber) {
  // 0 only wins on a straight bet on 0. All outside bets lose on 0.
  if (spun === 0) {
    return type === "straight" && betNumber === 0;
  }
  switch (type) {
    case "straight": return spun === betNumber;
    case "red":      return RED_NUMBERS.has(spun);
    case "black":    return BLACK_NUMBERS.has(spun);
    case "even":     return spun % 2 === 0;
    case "odd":      return spun % 2 === 1;
    case "low":      return spun >= 1 && spun <= 18;
    case "high":     return spun >= 19 && spun <= 36;
    case "dozen_1":  return spun >= 1 && spun <= 12;
    case "dozen_2":  return spun >= 13 && spun <= 24;
    case "dozen_3":  return spun >= 25 && spun <= 36;
    case "column_1": return spun % 3 === 1;
    case "column_2": return spun % 3 === 2;
    case "column_3": return spun % 3 === 0; // covers 3,6,9,...,36
    default: return false;
  }
}

/**
 * Format a bet description for display in embeds.
 * "Red", "Straight on 17", "Dozen 1 (1-12)", etc.
 */
export function describeBet({ type, number }) {
  switch (type) {
    case "straight": return `Straight on ${number}`;
    case "red":      return "Red";
    case "black":    return "Black";
    case "even":     return "Even";
    case "odd":      return "Odd";
    case "low":      return "Low (1-18)";
    case "high":     return "High (19-36)";
    case "dozen_1":  return "Dozen 1 (1-12)";
    case "dozen_2":  return "Dozen 2 (13-24)";
    case "dozen_3":  return "Dozen 3 (25-36)";
    case "column_1": return "Column 1 (1, 4, 7, …)";
    case "column_2": return "Column 2 (2, 5, 8, …)";
    case "column_3": return "Column 3 (3, 6, 9, …)";
    default:         return type;
  }
}
