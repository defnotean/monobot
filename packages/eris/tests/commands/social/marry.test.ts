import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  getBalance: vi.fn(),
  updateBalance: vi.fn(),
  getMarriage: vi.fn(),
  createMarriage: vi.fn(),
  hasItem: vi.fn(),
}));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as db from "../../../database.js";
import { execute } from "../../../commands/social/marry.js";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

function setHappyPath() {
  m.getMarriage.mockResolvedValue(null);
  m.hasItem.mockResolvedValue(true);
  m.getBalance.mockResolvedValue({ balance: 1000 });
  m.updateBalance.mockResolvedValue(undefined);
  m.createMarriage.mockResolvedValue(undefined);
}

describe("marry command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses marrying yourself", async () => {
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x" }),
      options: { user: makeUser({ id: "x" }) },
    });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/cant marry yourself/i);
    expect(m.getMarriage).not.toHaveBeenCalled();
  });

  it("refuses marrying a bot", async () => {
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x" }),
      options: { user: makeUser({ id: "b", bot: true }) },
    });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/bots have feelings/i);
  });

  it("blocks if the proposer is already married", async () => {
    m.getMarriage.mockResolvedValueOnce({ partner: "someone" });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x" }),
      options: { user: makeUser({ id: "y" }) },
    });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/already married/i);
    expect(m.createMarriage).not.toHaveBeenCalled();
  });

  it("blocks if the target is already married", async () => {
    // first call (proposer) -> null, second (target) -> married
    m.getMarriage.mockResolvedValueOnce(null).mockResolvedValueOnce({ partner: "z" });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x" }),
      options: { user: makeUser({ id: "y", username: "yuki" }) },
    });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toBe("yuki is already married");
    expect(m.createMarriage).not.toHaveBeenCalled();
  });

  it("requires a Wedding Ring before checking coins", async () => {
    m.getMarriage.mockResolvedValue(null);
    m.hasItem.mockResolvedValue(false);
    m.getBalance.mockResolvedValue({ balance: 9999 });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x" }),
      options: { user: makeUser({ id: "y" }) },
    });
    await execute(interaction);
    expect(m.hasItem).toHaveBeenCalledWith("x", "Wedding Ring");
    expect(getLastReplyContent(interaction)).toMatch(/Wedding Ring/);
    expect(m.createMarriage).not.toHaveBeenCalled();
  });

  it("requires at least 500 coins", async () => {
    m.getMarriage.mockResolvedValue(null);
    m.hasItem.mockResolvedValue(true);
    m.getBalance.mockResolvedValue({ balance: 499 });
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x" }),
      options: { user: makeUser({ id: "y" }) },
    });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/at least 500 coins/);
    expect(m.createMarriage).not.toHaveBeenCalled();
  });

  it("posts a target-only consent prompt instead of marrying immediately", async () => {
    setHappyPath();
    const interaction: any = makeInteraction({
      user: makeUser({ id: "x", username: "alice" }),
      options: { user: makeUser({ id: "y", username: "bob" }) },
    });
    await execute(interaction);

    expect(m.updateBalance).not.toHaveBeenCalled();
    expect(m.createMarriage).not.toHaveBeenCalled();
    expect(getLastReplyContent(interaction)).toMatch(/proposed/i);
    expect(getLastReply(interaction)?.payload.components?.[0]?.components?.map((c: any) => c.data.custom_id)).toEqual([
      "marry_accept_x_y",
      "marry_decline_x_y",
    ]);
  });
});
