// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const getLeaderboard = vi.fn();
vi.mock("../../../database.js", () => ({ getLeaderboard: (...a: any[]) => getLeaderboard(...a) }));

import { makeInteraction, makeClient, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/leaderboard.js"));
});

describe("economy/leaderboard", () => {
  it("registers a /leaderboard command", () => {
    expect(data.toJSON().name).toBe("leaderboard");
  });

  it("requests the top 10 and shows an empty message when nobody has coins", async () => {
    getLeaderboard.mockResolvedValue([]);
    const interaction = makeInteraction();
    await execute(interaction);
    expect(getLeaderboard).toHaveBeenCalledWith(10);
    expect(getLastReplyContent(interaction)).toContain("no one has coins yet");
  });

  it("ranks users with medals for the top 3 and numbers after", async () => {
    getLeaderboard.mockResolvedValue([
      { user_id: "a", balance: 1000 },
      { user_id: "b", balance: 900 },
      { user_id: "c", balance: 800 },
      { user_id: "d", balance: 700 },
    ]);
    // client.users.fetch returns a user whose username echoes the id
    const client = makeClient();
    client.users.fetch = vi.fn(async (id: string) => ({ id, username: `name-${id}` }));
    const interaction = makeInteraction({ client });
    await execute(interaction);

    const embed = getLastReply(interaction)?.payload.embeds[0];
    const json = embed.toJSON ? embed.toJSON() : embed.data;
    const desc = json.description;
    expect(desc).toContain("🥇 name-a");
    expect(desc).toContain("🥈 name-b");
    expect(desc).toContain("🥉 name-c");
    expect(desc).toContain("**4.** name-d");
    expect(desc).toContain("1,000");
  });

  it("falls back to 'Unknown' when a user fetch throws", async () => {
    getLeaderboard.mockResolvedValue([{ user_id: "ghost", balance: 42 }]);
    const client = makeClient();
    client.users.fetch = vi.fn(async () => {
      throw new Error("unknown user");
    });
    const interaction = makeInteraction({ client });
    await execute(interaction);
    const embed = getLastReply(interaction)?.payload.embeds[0];
    const json = embed.toJSON ? embed.toJSON() : embed.data;
    expect(json.description).toContain("Unknown");
    expect(json.description).toContain("42");
  });
});
