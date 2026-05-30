import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  getBalance: vi.fn(),
  createDuel: vi.fn(),
}));

vi.mock("../../../ai/gameVisuals.js", () => ({
  duelChallengeEmbed: vi.fn(() => ({
    embed: { data: { title: "duel" } },
    row: { components: [] },
  })),
}));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as db from "../../../database.js";
import { duelChallengeEmbed } from "../../../ai/gameVisuals.js";
import { execute } from "../../../commands/social/duel.js";

const m = db as unknown as {
  getBalance: ReturnType<typeof vi.fn>;
  createDuel: ReturnType<typeof vi.fn>;
};

describe("duel command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses self-duel before touching the wallet", async () => {
    const user = makeUser({ id: "self-1" });
    const interaction: any = makeInteraction({
      user,
      options: { user: makeUser({ id: "self-1" }), amount: 50 },
    });

    await execute(interaction);

    expect(getLastReplyContent(interaction)).toMatch(/cant duel yourself/i);
    expect(m.getBalance).not.toHaveBeenCalled();
    expect(m.createDuel).not.toHaveBeenCalled();
  });

  it("refuses dueling a bot", async () => {
    const interaction: any = makeInteraction({
      user: makeUser({ id: "u1" }),
      options: { user: makeUser({ id: "bot1", bot: true }), amount: 50 },
    });

    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/bots dont gamble/i);
    expect(m.getBalance).not.toHaveBeenCalled();
  });

  it("rejects a wager larger than the challenger's balance", async () => {
    m.getBalance.mockResolvedValue({ balance: 30 });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "u1" }),
      options: { user: makeUser({ id: "u2" }), amount: 100 },
    });

    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/you only have 30 coins/);
    expect(m.createDuel).not.toHaveBeenCalled();
  });

  it("surfaces createDuel failure error to the user", async () => {
    m.getBalance.mockResolvedValue({ balance: 1000 });
    m.createDuel.mockReturnValue({ success: false, error: "already in a duel" });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "u1" }),
      options: { user: makeUser({ id: "u2" }), amount: 100 },
    });

    await execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("already in a duel");
  });

  it("creates the duel and posts the challenge embed on success", async () => {
    m.getBalance.mockResolvedValue({ balance: 1000 });
    m.createDuel.mockReturnValue({ success: true });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "u1", username: "alice" }),
      channel: { id: "chan-9", send: vi.fn() },
      options: { user: makeUser({ id: "u2", username: "bob" }), amount: 250 },
    });

    await execute(interaction);

    // duel was created with the right args including channelId and amount.
    expect(m.createDuel).toHaveBeenCalledWith("u1", "u2", "chan-9", 250);
    expect(duelChallengeEmbed).toHaveBeenCalledWith("alice", "bob", "u2", 250);
    const payload = getLastReply(interaction)?.payload;
    expect(payload.embeds).toHaveLength(1);
    expect(payload.components).toHaveLength(1);
  });
});
