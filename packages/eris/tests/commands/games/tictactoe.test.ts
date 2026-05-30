import { describe, it, expect, afterEach, vi } from "vitest";
import { makeInteraction, makeUser } from "../../_helpers/mockDiscord.js";

import { execute, data } from "../../../commands/games/tictactoe.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("tictactoe command", () => {
  afterEach(() => vi.restoreAllMocks());

  it("declares the tictactoe command", () => {
    expect(data.name).toBe("tictactoe");
  });

  it("refuses a challenge against a bot", async () => {
    const interaction = makeInteraction({
      commandName: "tictactoe",
      options: { opponent: makeUser({ bot: true }) },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you can't challenge a bot");
    expect(interaction.fetchReply).not.toHaveBeenCalled();
  });

  it("refuses a challenge against yourself", async () => {
    const me = makeUser({ id: "self-2" });
    const interaction = makeInteraction({
      commandName: "tictactoe",
      user: me,
      options: { opponent: makeUser({ id: "self-2", bot: false }) },
    });
    await execute(interaction);

    expect(lastReply(interaction).content).toContain("you can't challenge yourself");
    expect(interaction.fetchReply).not.toHaveBeenCalled();
  });
});
