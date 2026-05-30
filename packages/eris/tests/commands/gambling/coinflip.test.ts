import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

// coinflip.js imports from ../../database.js, ../../ai/gameVisuals.js,
// ../../ai/gambling.js, ../../utils/logger.js — all of which exist & resolve,
// so vi.mock works. We hoist the spies so the mock factories can close over them.
const {
  tryDeductBalance,
  updateBalance,
  recordGameResult,
  coinflipEmbed,
  randomQuip,
  log,
} = vi.hoisted(() => ({
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  recordGameResult: vi.fn(),
  coinflipEmbed: vi.fn(),
  randomQuip: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  tryDeductBalance,
  updateBalance,
  recordGameResult,
}));
vi.mock("../../../ai/gameVisuals.js", () => ({ coinflipEmbed }));
vi.mock("../../../ai/gambling.js", () => ({ randomQuip }));
vi.mock("../../../utils/logger.js", () => ({ log }));

import { execute, data } from "../../../commands/gambling/coinflip.js";

/** last object passed to interaction.reply */
function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("coinflip command", () => {
  beforeEach(() => {
    tryDeductBalance.mockReset();
    updateBalance.mockReset();
    recordGameResult.mockReset();
    coinflipEmbed.mockReset();
    randomQuip.mockReset();
    randomQuip.mockReturnValue("quip!");
    // The result embed shape the command spreads into reply.
    coinflipEmbed.mockReturnValue({ embed: { e: 1 }, row: { r: 1 } });
    recordGameResult.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the coinflip command", () => {
    expect(data.name).toBe("coinflip");
  });

  it("replies ephemerally with the balance when funds are insufficient", async () => {
    tryDeductBalance.mockResolvedValue({ ok: false, reason: "insufficient", balance: 7 });
    const interaction = makeInteraction({
      commandName: "coinflip",
      options: { amount: 100, call: "heads" },
    });
    await execute(interaction);

    const reply = lastReply(interaction);
    expect(reply.content).toContain("you only have 7 coins");
    // Ephemeral flag set, and no payout/credit happened.
    expect(reply.flags).toBeDefined();
    expect(updateBalance).not.toHaveBeenCalled();
    expect(recordGameResult).not.toHaveBeenCalled();
    // The result embed should never be built on the reject path.
    expect(coinflipEmbed).not.toHaveBeenCalled();
  });

  it("surfaces a non-insufficient debit failure as 'couldn't place bet'", async () => {
    tryDeductBalance.mockResolvedValue({ ok: false, reason: "locked" });
    const interaction = makeInteraction({
      commandName: "coinflip",
      options: { amount: 50, call: "tails" },
    });
    await execute(interaction);

    const reply = lastReply(interaction);
    expect(reply.content).toContain("couldn't place bet");
    expect(reply.content).toContain("locked");
    expect(updateBalance).not.toHaveBeenCalled();
  });

  it("credits 2x the stake and records a win when the flip matches the call", async () => {
    // Math.random < 0.5 => "heads". Caller picks heads => win.
    vi.spyOn(Math, "random").mockReturnValue(0.2);
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400, reason: null });
    updateBalance.mockResolvedValue(600);
    const interaction = makeInteraction({
      commandName: "coinflip",
      options: { amount: 100, call: "heads" },
    });
    await execute(interaction);

    // Stake debit attempted with the user's id and the wagered amount.
    expect(tryDeductBalance).toHaveBeenCalledWith(
      interaction.user.id,
      100,
      "gamble_coinflip_stake",
      "coinflip:heads",
    );
    // Win path: credit 2x.
    expect(updateBalance).toHaveBeenCalledWith(
      interaction.user.id,
      200,
      "gamble_coinflip_win",
      "coinflip:heads",
    );
    // Recorded as a win with the 2x payout.
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "coinflip", true, 100, 200);
    // The embed is built with won=true and the post-win balance.
    expect(coinflipEmbed).toHaveBeenCalledWith("heads", "heads", true, 100, 600);
    const reply = lastReply(interaction);
    expect(reply.embeds).toEqual([{ e: 1 }]);
    expect(reply.content).toBe("quip!");
  });

  it("does not credit and records a loss when the flip misses the call", async () => {
    // Math.random >= 0.5 => "tails". Caller picks heads => loss.
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 300, reason: null });
    const interaction = makeInteraction({
      commandName: "coinflip",
      options: { amount: 100, call: "heads" },
    });
    await execute(interaction);

    expect(updateBalance).not.toHaveBeenCalled();
    // Recorded as a loss, payout 0; balance stays at the post-debit value.
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "coinflip", false, 100, 0);
    expect(coinflipEmbed).toHaveBeenCalledWith("heads", "tails", false, 100, 300);
  });
});
