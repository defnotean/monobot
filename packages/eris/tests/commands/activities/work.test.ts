import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

const {
  updateBalance,
  checkCooldown,
  setCooldown,
  getBalance,
  getCareerTier,
  incrementCareerCount,
} = vi.hoisted(() => ({
  updateBalance: vi.fn(),
  checkCooldown: vi.fn(),
  setCooldown: vi.fn(),
  getBalance: vi.fn(),
  getCareerTier: vi.fn(),
  incrementCareerCount: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  updateBalance,
  checkCooldown,
  setCooldown,
  getBalance,
  getCareerTier,
  incrementCareerCount,
}));

import { execute, data } from "../../../commands/activities/work.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("work command", () => {
  beforeEach(() => {
    updateBalance.mockReset().mockResolvedValue(undefined);
    checkCooldown.mockReset();
    setCooldown.mockReset();
    getBalance.mockReset().mockResolvedValue({ balance: 1000 });
    getCareerTier.mockReset().mockReturnValue({ bonus: 0, tier: 1 });
    incrementCareerCount.mockReset().mockReturnValue({ tier: 1, count: 3, bonus: 0 });
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the work command", () => {
    expect(data.name).toBe("work");
  });

  it("blocks while on cooldown and does not pay out", async () => {
    checkCooldown.mockReturnValue({ onCooldown: true, remainingMs: 120_000 });
    const interaction = makeInteraction({ commandName: "work" });
    await execute(interaction);

    const reply = lastReply(interaction);
    expect(reply.content).toContain("you already worked recently");
    expect(reply.content).toContain("2m"); // ceil(120000/60000)
    // No payout / no cooldown re-set when blocked.
    expect(setCooldown).not.toHaveBeenCalled();
    expect(updateBalance).not.toHaveBeenCalled();
  });

  it("pays out and sets the cooldown on a fresh shift", async () => {
    checkCooldown.mockReturnValue({ onCooldown: false });
    // Deterministic pay: random=0 => basePay 150, no overtime (0 < 0.15 is true,
    // so to AVOID overtime we need random >= 0.15 on the overtime roll). The job
    // pick and basePay both use random; force a value that skips overtime.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const interaction = makeInteraction({ commandName: "work" });
    await execute(interaction);

    expect(setCooldown).toHaveBeenCalledWith(interaction.user.id, "work");
    expect(incrementCareerCount).toHaveBeenCalledWith(interaction.user.id);
    // updateBalance called with (userId, coins, "work", jobTitle).
    expect(updateBalance).toHaveBeenCalledTimes(1);
    const [uid, coins, reason] = updateBalance.mock.calls[0];
    expect(uid).toBe(interaction.user.id);
    expect(reason).toBe("work");
    expect(coins).toBeGreaterThan(0);
    // Replies with an embed (no ephemeral text reject).
    expect(lastReply(interaction).embeds).toBeDefined();
  });

  it("doubles pay when the overtime roll hits", async () => {
    checkCooldown.mockReturnValue({ onCooldown: false });
    getCareerTier.mockReturnValue({ bonus: 0, tier: 1 });
    // random=0 => job index 0, basePay 150+0=150, overtime roll 0<0.15 => overtime.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const interaction = makeInteraction({ commandName: "work" });
    await execute(interaction);

    const [, coins] = updateBalance.mock.calls[0];
    expect(coins).toBe(300); // 150 base * 2 overtime
  });
});
