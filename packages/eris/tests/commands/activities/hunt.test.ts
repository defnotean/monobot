import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

const {
  updateBalance,
  checkCooldown,
  setCooldown,
  hasItem,
  getBalance,
  getActivityStreak,
  incrementActivityStreak,
  activityEmbed,
} = vi.hoisted(() => ({
  updateBalance: vi.fn(),
  checkCooldown: vi.fn(),
  setCooldown: vi.fn(),
  hasItem: vi.fn(),
  getBalance: vi.fn(),
  getActivityStreak: vi.fn(),
  incrementActivityStreak: vi.fn(),
  activityEmbed: vi.fn(),
}));

vi.mock("../../../database.js", () => ({
  updateBalance,
  checkCooldown,
  setCooldown,
  hasItem,
  getBalance,
  getActivityStreak,
  incrementActivityStreak,
}));
vi.mock("../../../ai/gameVisuals.js", () => ({ activityEmbed }));

import { execute, data } from "../../../commands/activities/hunt.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}
function makeEmbedStub() {
  return { setFooter: vi.fn().mockReturnThis(), addFields: vi.fn().mockReturnThis() };
}

describe("hunt command", () => {
  beforeEach(() => {
    updateBalance.mockReset().mockResolvedValue(undefined);
    checkCooldown.mockReset();
    setCooldown.mockReset();
    hasItem.mockReset().mockResolvedValue(false);
    getBalance.mockReset().mockResolvedValue({ balance: 500 });
    getActivityStreak.mockReset().mockReturnValue({ count: 0, bonus: 0 });
    incrementActivityStreak.mockReset().mockReturnValue(1);
    activityEmbed.mockReset().mockReturnValue({ embed: makeEmbedStub(), row: { r: 1 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the hunt command", () => {
    expect(data.name).toBe("hunt");
  });

  it("blocks while on cooldown", async () => {
    checkCooldown.mockReturnValue({ onCooldown: true, remainingSec: 30 });
    const interaction = makeInteraction({ commandName: "hunt" });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("30s");
    expect(updateBalance).not.toHaveBeenCalled();
  });

  it("checks for the Hunting Rifle and credits an encounter", async () => {
    checkCooldown.mockReturnValue({ onCooldown: false });
    vi.spyOn(Math, "random").mockReturnValue(0.999999); // skip rare event
    const interaction = makeInteraction({ commandName: "hunt" });
    await execute(interaction);

    expect(hasItem).toHaveBeenCalledWith(interaction.user.id, "Hunting Rifle");
    const [uid, coins, reason] = updateBalance.mock.calls[0];
    expect(uid).toBe(interaction.user.id);
    expect(reason).toBe("hunt");
    expect(coins).toBeGreaterThan(0);
    expect(lastReply(interaction).components).toHaveLength(1);
  });

  it("adds the dragon-nest event row when the event triggers", async () => {
    checkCooldown.mockReturnValue({ onCooldown: false });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const interaction = makeInteraction({ commandName: "hunt" });
    await execute(interaction);

    expect(lastReply(interaction).components).toHaveLength(2);
  });
});
