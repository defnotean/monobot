// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUnlockedAchievements = vi.fn();
vi.mock("../../../database.js", () => ({
  getUnlockedAchievements: (...a: any[]) => getUnlockedAchievements(...a),
}));

// ACHIEVEMENTS is a real export; we only need it referenced. gameVisuals builds an embed.
const achievementsEmbed = vi.fn(() => ({ __embed: "achievements" }));
vi.mock("../../../ai/economy.js", () => ({ ACHIEVEMENTS: [{ key: "first" }, { key: "rich" }] }));
vi.mock("../../../ai/gameVisuals.js", () => ({
  achievementsEmbed: (...a: any[]) => achievementsEmbed(...a),
}));

import { makeInteraction, makeUser, getLastReply } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/achievements.js"));
});

describe("economy/achievements", () => {
  it("registers a /achievements command", () => {
    expect(data.toJSON().name).toBe("achievements");
  });

  it("passes the set of unlocked keys + display name into the embed builder", async () => {
    getUnlockedAchievements.mockResolvedValue([
      { achievement_key: "first" },
      { achievement_key: "rich" },
    ]);
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }) });
    interaction.user.displayName = "Cooluser";
    await execute(interaction);

    expect(getUnlockedAchievements).toHaveBeenCalledWith("u1");
    // 3rd arg is displayName; 2nd is the Set of unlocked keys
    const call = achievementsEmbed.mock.calls[0];
    const unlockedSet = call[1];
    expect(unlockedSet).toBeInstanceOf(Set);
    expect(unlockedSet.has("first")).toBe(true);
    expect(unlockedSet.has("rich")).toBe(true);
    expect(call[2]).toBe("Cooluser");
    expect(getLastReply(interaction)?.payload.embeds).toEqual([{ __embed: "achievements" }]);
  });

  it("tolerates a null/empty unlocked list (empty Set)", async () => {
    getUnlockedAchievements.mockResolvedValue(null);
    const interaction = makeInteraction();
    await execute(interaction);
    const unlockedSet = achievementsEmbed.mock.calls[0][1];
    expect(unlockedSet.size).toBe(0);
    // still replies with the embed
    expect(getLastReply(interaction)?.payload.embeds).toBeTruthy();
  });
});
