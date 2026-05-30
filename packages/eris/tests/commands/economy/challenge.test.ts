// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const getDailyChallenge = vi.fn();
const createDailyChallenge = vi.fn();
vi.mock("../../../database.js", () => ({
  getDailyChallenge: (...a: any[]) => getDailyChallenge(...a),
  createDailyChallenge: (...a: any[]) => createDailyChallenge(...a),
}));

const generateChallenge = vi.fn(() => ({ type: "earn", target: 100, reward: 50 }));
vi.mock("../../../ai/economy.js", () => ({
  generateChallenge: (...a: any[]) => generateChallenge(...a),
}));

const dailyChallengeEmbed = vi.fn(() => ({ embed: { __embed: "ch" }, row: { __row: "r" } }));
vi.mock("../../../ai/gameVisuals.js", () => ({
  dailyChallengeEmbed: (...a: any[]) => dailyChallengeEmbed(...a),
}));

import { makeInteraction, makeUser, makeGuild, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/challenge.js"));
});

describe("economy/challenge", () => {
  it("registers a /challenge command", () => {
    expect(data.toJSON().name).toBe("challenge");
  });

  it("refuses to run outside a guild (DM) ephemerally", async () => {
    const interaction = makeInteraction({ guild: null });
    await execute(interaction);
    const last = getLastReply(interaction);
    expect(last?.content).toContain("only works in servers");
    expect(last?.payload.flags).toBeDefined();
    expect(getDailyChallenge).not.toHaveBeenCalled();
  });

  it("shows an existing challenge and marks completion for the caller", async () => {
    getDailyChallenge.mockResolvedValue({ id: 1, completed_by: ["u1", "uX"] });
    const interaction = makeInteraction({
      guild: makeGuild({ id: "g1" }),
      user: makeUser({ id: "u1" }),
    });
    await execute(interaction);
    expect(getDailyChallenge).toHaveBeenCalledTimes(1);
    expect(createDailyChallenge).not.toHaveBeenCalled();
    // completed flag (2nd arg) must be true since u1 is in completed_by
    expect(dailyChallengeEmbed.mock.calls[0][1]).toBe(true);
    const payload = getLastReply(interaction)?.payload;
    expect(payload.embeds).toEqual([{ __embed: "ch" }]);
    expect(payload.components).toEqual([{ __row: "r" }]);
  });

  it("auto-generates a challenge when none exists for today", async () => {
    // first lookup: none; after create: present
    getDailyChallenge
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 2, completed_by: [] });
    const interaction = makeInteraction({ guild: makeGuild({ id: "g2" }), user: makeUser({ id: "u9" }) });
    await execute(interaction);
    expect(generateChallenge).toHaveBeenCalled();
    // create called with generated type/target/reward
    expect(createDailyChallenge).toHaveBeenCalledWith("g2", "earn", 100, 50, expect.any(String));
    // not completed by u9
    expect(dailyChallengeEmbed.mock.calls[0][1]).toBe(false);
    expect(getLastReply(interaction)?.payload.embeds).toBeTruthy();
  });

  it("errors ephemerally if generation still yields no challenge", async () => {
    getDailyChallenge.mockResolvedValue(null); // never resolves to a challenge
    const interaction = makeInteraction({ guild: makeGuild({ id: "g3" }) });
    await execute(interaction);
    const last = getLastReply(interaction);
    expect(last?.content).toContain("couldn't generate challenge");
    expect(last?.payload.flags).toBeDefined();
    expect(dailyChallengeEmbed).not.toHaveBeenCalled();
  });

  it("sends empty components array when the embed builder returns no row", async () => {
    getDailyChallenge.mockResolvedValue({ id: 5, completed_by: [] });
    dailyChallengeEmbed.mockReturnValueOnce({ embed: { __embed: "x" }, row: null });
    const interaction = makeInteraction({ guild: makeGuild(), user: makeUser({ id: "u1" }) });
    await execute(interaction);
    expect(getLastReply(interaction)?.payload.components).toEqual([]);
  });
});
