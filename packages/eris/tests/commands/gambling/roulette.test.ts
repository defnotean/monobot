import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

const {
  tryDeductBalance,
  updateBalance,
  recordGameResult,
  getBalance,
  spin,
  colorOf,
  validateBet,
  resolveBet,
  describeBet,
  BET_TYPES,
  log,
} = vi.hoisted(() => ({
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  recordGameResult: vi.fn(),
  getBalance: vi.fn(),
  spin: vi.fn(),
  colorOf: vi.fn(),
  validateBet: vi.fn(),
  resolveBet: vi.fn(),
  describeBet: vi.fn(),
  BET_TYPES: [],
  log: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  tryDeductBalance,
  updateBalance,
  recordGameResult,
  getBalance,
}));
vi.mock("../../../ai/gambling/roulette.js", () => ({
  spin,
  colorOf,
  validateBet,
  resolveBet,
  describeBet,
  BET_TYPES,
}));
vi.mock("../../../utils/logger.js", () => ({ log }));

import { execute, data } from "../../../commands/gambling/roulette.js";

function replyCalls(interaction: any) {
  return interaction.reply.mock.calls.map((c: any[]) => c[0]);
}
function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("roulette command", () => {
  beforeEach(() => {
    tryDeductBalance.mockReset();
    updateBalance.mockReset();
    recordGameResult.mockReset().mockResolvedValue(undefined);
    getBalance.mockReset();
    spin.mockReset().mockReturnValue(17);
    colorOf.mockReset().mockReturnValue("black");
    validateBet.mockReset();
    resolveBet.mockReset();
    describeBet.mockReset().mockReturnValue("black (1:1)");
    // Avoid the 1500ms real spin delay in the success path.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("declares the roulette command", () => {
    expect(data.name).toBe("roulette");
  });

  it("rejects a straight bet missing a number with a targeted message", async () => {
    validateBet.mockReturnValue({ ok: false, reason: "invalid_number" });
    const interaction = makeInteraction({
      commandName: "roulette",
      options: { bet: "straight", amount: 50 },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("straight bets need a number");
    // Validation fails before any debit.
    expect(tryDeductBalance).not.toHaveBeenCalled();
  });

  it("rejects other invalid bets with the generic reason", async () => {
    validateBet.mockReturnValue({ ok: false, reason: "invalid_amount" });
    const interaction = makeInteraction({
      commandName: "roulette",
      options: { bet: "red", amount: -5 },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("invalid bet: invalid_amount");
    expect(tryDeductBalance).not.toHaveBeenCalled();
  });

  it("rejects an insufficient balance after a valid bet", async () => {
    validateBet.mockReturnValue({ ok: true });
    tryDeductBalance.mockResolvedValue({ ok: false, reason: "insufficient", balance: 9 });
    const interaction = makeInteraction({
      commandName: "roulette",
      options: { bet: "red", amount: 100 },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you only have 9 coins");
    expect(spin).not.toHaveBeenCalled();
  });

  it("spins, credits the payout on a win, and edits in the result", async () => {
    validateBet.mockReturnValue({ ok: true });
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    resolveBet.mockReturnValue({ won: true, payout: 200 });
    updateBalance.mockResolvedValue(600);
    const interaction = makeInteraction({
      commandName: "roulette",
      options: { bet: "red", amount: 100 },
    });
    const p = execute(interaction);
    await vi.runAllTimersAsync();
    await p;

    expect(spin).toHaveBeenCalled();
    expect(updateBalance).toHaveBeenCalledWith(
      interaction.user.id,
      200,
      "roulette_win",
      expect.stringContaining("spun:17"),
    );
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "roulette", true, 100, 200);
    // The "spinning…" placeholder is a reply, the result is an editReply.
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it("does not credit on a loss but still records the result", async () => {
    validateBet.mockReturnValue({ ok: true });
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    resolveBet.mockReturnValue({ won: false, payout: 0 });
    const interaction = makeInteraction({
      commandName: "roulette",
      options: { bet: "red", amount: 100 },
    });
    const p = execute(interaction);
    await vi.runAllTimersAsync();
    await p;

    expect(updateBalance).not.toHaveBeenCalled();
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "roulette", false, 100, 0);
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
