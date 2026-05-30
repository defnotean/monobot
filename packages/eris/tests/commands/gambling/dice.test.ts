import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

const {
  tryDeductBalance,
  updateBalance,
  recordGameResult,
  diceEmbed,
  diceButtonsEmbed,
  randomQuip,
  log,
} = vi.hoisted(() => ({
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  recordGameResult: vi.fn(),
  diceEmbed: vi.fn(),
  diceButtonsEmbed: vi.fn(),
  randomQuip: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  tryDeductBalance,
  updateBalance,
  recordGameResult,
}));
vi.mock("../../../ai/gameVisuals.js", () => ({ diceEmbed, diceButtonsEmbed }));
vi.mock("../../../ai/gambling.js", () => ({ randomQuip }));
vi.mock("../../../utils/logger.js", () => ({ log }));

import { execute, data } from "../../../commands/gambling/dice.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("dice command", () => {
  beforeEach(() => {
    tryDeductBalance.mockReset();
    updateBalance.mockReset();
    recordGameResult.mockReset();
    diceEmbed.mockReset().mockReturnValue({ d: 1 });
    diceButtonsEmbed.mockReset().mockReturnValue({ row: { r: 1 } });
    randomQuip.mockReset().mockReturnValue("quip!");
    recordGameResult.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the dice command", () => {
    expect(data.name).toBe("dice");
  });

  it("rejects an insufficient balance ephemerally without paying out", async () => {
    tryDeductBalance.mockResolvedValue({ ok: false, reason: "insufficient", balance: 3 });
    const interaction = makeInteraction({
      commandName: "dice",
      options: { amount: 100, guess: 4 },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you only have 3 coins");
    expect(updateBalance).not.toHaveBeenCalled();
    expect(recordGameResult).not.toHaveBeenCalled();
    expect(diceEmbed).not.toHaveBeenCalled();
  });

  it("credits 5x and records a win when the roll equals the guess", async () => {
    // roll = floor(random*6)+1; random=0 => roll 1. Guess 1 => win.
    vi.spyOn(Math, "random").mockReturnValue(0);
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    updateBalance.mockResolvedValue(900);
    const interaction = makeInteraction({
      commandName: "dice",
      options: { amount: 100, guess: 1 },
    });
    await execute(interaction);

    expect(tryDeductBalance).toHaveBeenCalledWith(interaction.user.id, 100, "gamble_dice_stake", "dice:1");
    expect(updateBalance).toHaveBeenCalledWith(interaction.user.id, 500, "gamble_dice_win", "dice:1");
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "dice", true, 100, 500);
    expect(diceEmbed).toHaveBeenCalledWith(1, 1, true, 100, 900);
  });

  it("does not credit and records a loss when the roll misses the guess", async () => {
    // random=0 => roll 1. Guess 6 => loss.
    vi.spyOn(Math, "random").mockReturnValue(0);
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    const interaction = makeInteraction({
      commandName: "dice",
      options: { amount: 100, guess: 6 },
    });
    await execute(interaction);

    expect(updateBalance).not.toHaveBeenCalled();
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "dice", false, 100, 0);
    expect(diceEmbed).toHaveBeenCalledWith(6, 1, false, 100, 400);
  });
});
