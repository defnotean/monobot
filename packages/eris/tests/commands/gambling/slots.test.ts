import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

const {
  tryDeductBalance,
  updateBalance,
  recordGameResult,
  getMood,
  getRelationship,
  slotsEmbed,
  slotsAnimFrames,
  animateEmbed,
  spinSlots,
  slotsPayout,
  randomQuip,
  log,
} = vi.hoisted(() => ({
  tryDeductBalance: vi.fn(),
  updateBalance: vi.fn(),
  recordGameResult: vi.fn(),
  getMood: vi.fn(),
  getRelationship: vi.fn(),
  slotsEmbed: vi.fn(),
  slotsAnimFrames: vi.fn(),
  animateEmbed: vi.fn(),
  spinSlots: vi.fn(),
  slotsPayout: vi.fn(),
  randomQuip: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  tryDeductBalance,
  updateBalance,
  recordGameResult,
  getMood,
  getRelationship,
}));
vi.mock("../../../ai/gameVisuals.js", () => ({ slotsEmbed, slotsAnimFrames, animateEmbed }));
vi.mock("../../../ai/gambling.js", () => ({ spinSlots, slotsPayout, randomQuip }));
vi.mock("../../../utils/logger.js", () => ({ log }));

import { execute, data } from "../../../commands/gambling/slots.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("slots command", () => {
  beforeEach(() => {
    tryDeductBalance.mockReset();
    updateBalance.mockReset();
    recordGameResult.mockReset().mockResolvedValue(undefined);
    getMood.mockReset().mockReturnValue({ mood_score: 0 });
    getRelationship.mockReset().mockReturnValue({ affinity_score: 0 });
    spinSlots.mockReset().mockReturnValue([{ emoji: "🍒" }, { emoji: "🍒" }, { emoji: "🍒" }]);
    slotsPayout.mockReset();
    slotsEmbed.mockReset().mockReturnValue({ embed: { e: 1 }, row: { r: 1 } });
    // Keep animation frames empty so the editReply loop runs exactly once
    // (the final result frame) and there are no setTimeout delays between frames.
    slotsAnimFrames.mockReset().mockReturnValue([]);
    randomQuip.mockReset().mockReturnValue("quip!");
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the slots command", () => {
    expect(data.name).toBe("slots");
  });

  it("rejects an insufficient balance ephemerally and never spins", async () => {
    tryDeductBalance.mockResolvedValue({ ok: false, reason: "insufficient", balance: 5 });
    const interaction = makeInteraction({
      commandName: "slots",
      options: { amount: 100 },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you only have 5 coins");
    // Reject path short-circuits before the spin and before deferReply.
    expect(spinSlots).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(updateBalance).not.toHaveBeenCalled();
  });

  it("credits floor(amount*multiplier) on a win and records the win", async () => {
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    slotsPayout.mockReturnValue({ multiplier: 3, label: "three cherries" });
    updateBalance.mockResolvedValue(700);
    const interaction = makeInteraction({
      commandName: "slots",
      options: { amount: 100 },
    });
    await execute(interaction);

    expect(tryDeductBalance).toHaveBeenCalledWith(interaction.user.id, 100, "gamble_slots_stake", "slots:spin");
    expect(updateBalance).toHaveBeenCalledWith(interaction.user.id, 300, "gamble_slots_win", "slots:three cherries");
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "slots", true, 100, 300);
    // Animated flow: defer then edit (no reply()).
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it("makes no credit on a no-match (multiplier 0) result", async () => {
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    slotsPayout.mockReturnValue({ multiplier: 0, label: "no match" });
    const interaction = makeInteraction({
      commandName: "slots",
      options: { amount: 100 },
    });
    await execute(interaction);

    expect(updateBalance).not.toHaveBeenCalled();
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "slots", false, 100, 0);
  });

  it("debits an extra stake on a double-skull (multiplier -2) result", async () => {
    tryDeductBalance.mockResolvedValue({ ok: true, newBalance: 400 });
    slotsPayout.mockReturnValue({ multiplier: -2, label: "double skull" });
    updateBalance.mockResolvedValue(300);
    const interaction = makeInteraction({
      commandName: "slots",
      options: { amount: 100 },
    });
    await execute(interaction);

    // credit === -amount for the double-skull case.
    expect(updateBalance).toHaveBeenCalledWith(interaction.user.id, -100, "gamble_slots_loss", "slots:double skull");
    expect(recordGameResult).toHaveBeenCalledWith(interaction.user.id, "slots", false, 100, 0);
  });
});
