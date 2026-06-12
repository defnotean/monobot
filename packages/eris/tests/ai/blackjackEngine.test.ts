import { describe, expect, it } from "vitest";

import { resolveAction } from "../../ai/blackjackEngine.js";

function card(rank: string) {
  return { rank, suit: "S" };
}

function deckForDraws(...ranks: string[]) {
  return [...ranks].reverse();
}

function state({
  deck = [],
  player = [],
  dealer = [],
  stake = 100,
}: {
  deck?: string[];
  player?: string[];
  dealer?: string[];
  stake?: number;
}) {
  return {
    deck: deck.map(card),
    playerHand: player.map(card),
    dealerHand: dealer.map(card),
    stake,
  };
}

describe("blackjackEngine", () => {
  it("hit adds one player card and keeps the hand active below 21", () => {
    const result = resolveAction(state({
      deck: deckForDraws("5"),
      player: ["10", "4"],
      dealer: ["K", "6"],
      stake: 75,
    }), "hit");

    expect(result.resolved).toBe(false);
    expect(result.outcome).toBe("continue");
    expect(result.state.playerHand.map((c) => c.rank)).toEqual(["10", "4", "5"]);
    expect(result.state.dealerHand.map((c) => c.rank)).toEqual(["K", "6"]);
    expect(result.state.stake).toBe(75);
    expect(result.payout).toBe(0);
    expect(result.credit).toBe(0);
  });

  it("stand resolves against the dealer and pays a winning hand", () => {
    const result = resolveAction(state({
      deck: deckForDraws("2"),
      player: ["10", "9"],
      dealer: ["10", "6"],
      stake: 100,
    }), "stand");

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe("win");
    expect(result.resultText).toBe("You Win!");
    expect(result.playerValue).toBe(19);
    expect(result.dealerValue).toBe(18);
    expect(result.payout).toBe(100);
    expect(result.credit).toBe(200);
    expect(result.won).toBe(true);
    expect(result.recordPayout).toBe(200);
  });

  it("double draws once, doubles the stake, and resolves immediately", () => {
    const result = resolveAction(state({
      deck: deckForDraws("10", "2"),
      player: ["9", "2"],
      dealer: ["10", "6"],
      stake: 50,
    }), "double");

    expect(result.resolved).toBe(true);
    expect(result.state.stake).toBe(100);
    expect(result.state.playerHand.map((c) => c.rank)).toEqual(["9", "2", "10"]);
    expect(result.state.dealerHand.map((c) => c.rank)).toEqual(["10", "6", "2"]);
    expect(result.outcome).toBe("win");
    expect(result.payout).toBe(100);
    expect(result.credit).toBe(200);
  });

  it("bust resolves without dealer draws or settlement credit", () => {
    const result = resolveAction(state({
      deck: deckForDraws("K", "5"),
      player: ["10", "6"],
      dealer: ["9", "7"],
      stake: 40,
    }), "hit");

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe("bust");
    expect(result.resultText).toBe("BUST!");
    expect(result.state.playerHand.map((c) => c.rank)).toEqual(["10", "6", "K"]);
    expect(result.state.dealerHand.map((c) => c.rank)).toEqual(["9", "7"]);
    expect(result.dealerValue).toBe(16);
    expect(result.payout).toBe(-40);
    expect(result.credit).toBe(0);
    expect(result.won).toBe(false);
  });

  it("push refunds the escrowed stake without recording a win or loss", () => {
    const result = resolveAction(state({
      deck: deckForDraws("4"),
      player: ["10", "10"],
      dealer: ["10", "6"],
      stake: 30,
    }), "stand");

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe("push");
    expect(result.resultText).toBe("Push (Tie)");
    expect(result.dealerValue).toBe(20);
    expect(result.payout).toBe(0);
    expect(result.credit).toBe(30);
    expect(result.won).toBeNull();
    expect(result.recordPayout).toBe(0);
  });

  it("dealer draws until reaching 17", () => {
    const result = resolveAction(state({
      deck: deckForDraws("4", "A", "K"),
      player: ["10", "8"],
      dealer: ["10", "2"],
      stake: 25,
    }), "stand");

    expect(result.resolved).toBe(true);
    expect(result.state.dealerHand.map((c) => c.rank)).toEqual(["10", "2", "4", "A"]);
    expect(result.dealerValue).toBe(17);
  });

  it("dealer stands on soft 17", () => {
    const result = resolveAction(state({
      deck: deckForDraws("5"),
      player: ["10", "8"],
      dealer: ["A", "6"],
      stake: 25,
    }), "stand");

    expect(result.resolved).toBe(true);
    expect(result.state.dealerHand.map((c) => c.rank)).toEqual(["A", "6"]);
    expect(result.state.deck.map((c) => c.rank)).toEqual(["5"]);
    expect(result.dealerValue).toBe(17);
  });
});
