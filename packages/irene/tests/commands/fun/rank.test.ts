// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports, so its factory cannot close over a normal
// top-level const. vi.hoisted lifts the mock object alongside it.
const leveling = vi.hoisted(() => ({
  getXpData: vi.fn(),
  getLeaderboard: vi.fn(),
  xpNeededForLevel: vi.fn(),
}));
vi.mock("../../../utils/leveling.js", () => leveling);

// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/rank.js";

beforeEach(() => {
  leveling.getXpData.mockReset();
  leveling.getLeaderboard.mockReset();
  leveling.xpNeededForLevel.mockReset();
  leveling.xpNeededForLevel.mockReturnValue(100);
});

describe("fun/rank", () => {
  it("declares an optional user option", () => {
    const json = cmd.data.toJSON();
    const u = json.options.find((o: any) => o.name === "user");
    expect(u).toBeTruthy();
    expect(u.required).toBeFalsy();
  });

  it("shows the no-XP message when the user has zero level and xp", async () => {
    leveling.getXpData.mockReturnValue({ xp: 0, level: 0, totalXp: 0 });
    leveling.getLeaderboard.mockReturnValue([]);
    const interaction = makeInteraction({ user: makeUser({ username: "alice" }) });
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const text = repliedText(interaction);
    expect(text).toContain("alice's Rank");
    expect(text).toContain("no XP yet");
  });

  it("renders rank/level/xp fields and computes rank from leaderboard position", async () => {
    const user = makeUser({ id: "u-self", username: "bob" });
    leveling.getXpData.mockReturnValue({ xp: 40, level: 2, totalXp: 240 });
    leveling.getLeaderboard.mockReturnValue([
      { userId: "other" },
      { userId: "u-self" }, // index 1 -> rank #2
    ]);
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);

    const fields = lastReply(interaction).embeds[0].data.fields;
    const rank = fields.find((f: any) => f.name === "Rank");
    const level = fields.find((f: any) => f.name === "Level");
    const cur = fields.find((f: any) => f.name === "Current XP");
    expect(rank.value).toBe("#2");
    expect(level.value).toBe("2");
    expect(cur.value).toBe("40/100");
  });

  it("labels an off-leaderboard user as Unranked", async () => {
    const user = makeUser({ id: "ghost" });
    leveling.getXpData.mockReturnValue({ xp: 10, level: 1, totalXp: 110 });
    leveling.getLeaderboard.mockReturnValue([{ userId: "someone-else" }]);
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    const fields = lastReply(interaction).embeds[0].data.fields;
    expect(fields.find((f: any) => f.name === "Rank").value).toBe("Unranked");
  });

  it("checks the target user from the option, not the caller", async () => {
    const caller = makeUser({ id: "caller" });
    const target = makeUser({ id: "target", username: "carol" });
    leveling.getXpData.mockReturnValue({ xp: 5, level: 1, totalXp: 105 });
    leveling.getLeaderboard.mockReturnValue([{ userId: "target" }]);
    const interaction = makeInteraction({ user: caller, options: { user: target } });
    await cmd.execute(interaction);

    // getXpData must be called with the target's id, not the caller's.
    expect(leveling.getXpData).toHaveBeenCalledWith(interaction.guildId, "target");
    expect(repliedText(interaction)).toContain("carol's Rank");
  });
});
