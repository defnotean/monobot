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

import { execute, data } from "../../../commands/activities/dig.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

/** activityEmbed returns { embed, row }; embed exposes the chained methods dig.js calls. */
function makeEmbedStub() {
  return { setFooter: vi.fn().mockReturnThis(), addFields: vi.fn().mockReturnThis() };
}

describe("dig command", () => {
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

  it("declares the dig command", () => {
    expect(data.name).toBe("dig");
  });

  it("blocks while on cooldown and never touches the balance", async () => {
    checkCooldown.mockReturnValue({ onCooldown: true, remainingSec: 12 });
    const interaction = makeInteraction({ commandName: "dig" });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("12s");
    expect(setCooldown).not.toHaveBeenCalled();
    expect(updateBalance).not.toHaveBeenCalled();
  });

  it("digs, credits coins, and replies with the find on a normal roll", async () => {
    checkCooldown.mockReturnValue({ onCooldown: false });
    // Force the weighted pick to the first find and skip the rare event:
    //   roll = random * totalWeight -> 0 lands on finds[0]
    //   eventChance check: random < eventChance must be FALSE -> use a high value.
    // Two random() reads occur (pick, then event). Return high so pick lands on
    // the LAST element (still deterministic) and the event branch is skipped.
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const interaction = makeInteraction({ commandName: "dig" });
    await execute(interaction);

    expect(setCooldown).toHaveBeenCalledWith(interaction.user.id, "dig");
    expect(incrementActivityStreak).toHaveBeenCalledWith(interaction.user.id, "dig");
    // updateBalance(userId, coins, "dig", itemName) with a positive payout.
    expect(updateBalance).toHaveBeenCalledTimes(1);
    const [uid, coins, reason] = updateBalance.mock.calls[0];
    expect(uid).toBe(interaction.user.id);
    expect(reason).toBe("dig");
    expect(coins).toBeGreaterThan(0);
    // Normal (non-event) reply carries the base [embed][row] (1 component row).
    const reply = lastReply(interaction);
    expect(reply.components).toHaveLength(1);
  });

  it("attaches the rare-event button row when the event roll triggers", async () => {
    checkCooldown.mockReturnValue({ onCooldown: false });
    // First random (pick) -> 0 lands on finds[0]; second random (event) -> 0 < eventChance => event fires.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const interaction = makeInteraction({ commandName: "dig" });
    await execute(interaction);

    // Event path replies with TWO component rows (base row + event row).
    const reply = lastReply(interaction);
    expect(reply.components).toHaveLength(2);
  });
});
