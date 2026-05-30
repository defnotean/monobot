import { describe, it, expect, afterEach, vi } from "vitest";
import { makeInteraction, makeUser } from "../../_helpers/mockDiscord.js";

// The connect4 game engine is real and pure — no need to mock it. The command
// only reaches the engine after an async collector is set up; we test the two
// synchronous guard branches that run before any collector machinery.
import { execute, data } from "../../../commands/games/connect4.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("connect4 command", () => {
  afterEach(() => vi.restoreAllMocks());

  it("declares the connect4 command", () => {
    expect(data.name).toBe("connect4");
  });

  it("refuses a challenge against a bot", async () => {
    const interaction = makeInteraction({
      commandName: "connect4",
      options: { opponent: makeUser({ bot: true }) },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you can't challenge a bot");
    // Guard short-circuits before sending the challenge embed.
    expect(interaction.fetchReply).not.toHaveBeenCalled();
  });

  it("refuses a challenge against yourself", async () => {
    const me = makeUser({ id: "self-1" });
    const interaction = makeInteraction({
      commandName: "connect4",
      user: me,
      options: { opponent: makeUser({ id: "self-1", bot: false }) },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you can't challenge yourself");
    expect(interaction.fetchReply).not.toHaveBeenCalled();
  });
});
