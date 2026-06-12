import { handValue } from "./gambling.js";

/**
 * @typedef {{ rank?: string, suit?: string, [key: string]: unknown }} Card
 * @typedef {{ deck: Card[], playerHand: Card[], dealerHand: Card[], stake: number }} BlackjackState
 * @typedef {"hit" | "stand" | "double"} BlackjackAction
 * @typedef {"continue" | "bust" | "win" | "loss" | "push"} BlackjackOutcome
 * @typedef {{
 *   state: BlackjackState,
 *   resolved: boolean,
 *   outcome: BlackjackOutcome,
 *   resultText: string | null,
 *   playerValue: number,
 *   dealerValue: number,
 *   payout: number,
 *   credit: number,
 *   won: boolean | null,
 *   recordPayout: number,
 * }} BlackjackResult
 */

/**
 * @param {BlackjackState} state
 * @returns {BlackjackState}
 */
function cloneState(state) {
  return {
    deck: [...state.deck],
    playerHand: [...state.playerHand],
    dealerHand: [...state.dealerHand],
    stake: state.stake,
  };
}

/**
 * @param {BlackjackState} state
 * @returns {BlackjackResult}
 */
function activeResult(state) {
  return {
    state,
    resolved: false,
    outcome: "continue",
    resultText: null,
    playerValue: handValue(state.playerHand),
    dealerValue: handValue(state.dealerHand),
    payout: 0,
    credit: 0,
    won: null,
    recordPayout: 0,
  };
}

/**
 * @param {BlackjackState} state
 * @param {BlackjackOutcome} outcome
 * @param {string} resultText
 * @param {boolean | null} won
 * @returns {BlackjackResult}
 */
function resolvedResult(state, outcome, resultText, won) {
  const playerValue = handValue(state.playerHand);
  const dealerValue = handValue(state.dealerHand);
  const stake = state.stake;
  const credit = won === true ? stake * 2 : won === null ? stake : 0;
  const payout = won === true ? stake : won === false ? -stake : 0;

  return {
    state,
    resolved: true,
    outcome,
    resultText,
    playerValue,
    dealerValue,
    payout,
    credit,
    won,
    recordPayout: won === true ? stake * 2 : 0,
  };
}

/**
 * Resolve one blackjack player action against an escrowed-stake game state.
 *
 * The returned `credit` is the amount the caller should credit back after the
 * initial stake escrow: win = 2x stake, push = 1x stake, loss = 0.
 *
 * @param {BlackjackState} state
 * @param {BlackjackAction} action
 * @returns {BlackjackResult}
 */
export function resolveAction(state, action) {
  const next = cloneState(state);

  if (action === "double") {
    next.stake *= 2;
    const card = next.deck.pop();
    if (card) next.playerHand.push(card);
  } else if (action === "hit") {
    const card = next.deck.pop();
    if (card) next.playerHand.push(card);
    if (handValue(next.playerHand) < 21) return activeResult(next);
  } else if (action !== "stand") {
    throw new Error(`unknown blackjack action: ${action}`);
  }

  if (handValue(next.playerHand) > 21) {
    return resolvedResult(next, "bust", "BUST!", false);
  }

  while (handValue(next.dealerHand) < 17) {
    const card = next.deck.pop();
    if (!card) break;
    next.dealerHand.push(card);
  }

  const playerValue = handValue(next.playerHand);
  const dealerValue = handValue(next.dealerHand);
  if (dealerValue > 21) return resolvedResult(next, "win", "Dealer Busts!", true);
  if (playerValue > dealerValue) return resolvedResult(next, "win", "You Win!", true);
  if (playerValue < dealerValue) return resolvedResult(next, "loss", "Dealer Wins", false);
  return resolvedResult(next, "push", "Push (Tie)", null);
}
