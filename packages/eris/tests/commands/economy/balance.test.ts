// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock the data layer the command reads ──
const getBalance = vi.fn();
vi.mock("../../../database.js", () => ({ getBalance: (...a: any[]) => getBalance(...a) }));

import { makeInteraction, makeUser, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/balance.js"));
});

describe("economy/balance", () => {
  it("registers a /balance command with an optional user option", () => {
    const json = data.toJSON();
    expect(json.name).toBe("balance");
    const userOpt = json.options.find((o: any) => o.name === "user");
    expect(userOpt).toBeTruthy();
    expect(userOpt.required).toBe(false);
  });

  it("defaults to the invoking user when no user option is given", async () => {
    getBalance.mockResolvedValue({ balance: 1234 });
    const interaction = makeInteraction({ user: makeUser({ id: "u-self", username: "selfie" }) });
    await execute(interaction);
    // looked up the caller's own id
    expect(getBalance).toHaveBeenCalledWith("u-self");
    const msg = getLastReplyContent(interaction);
    expect(msg).toContain("selfie");
    // toLocaleString inserts a grouping separator
    expect(msg).toContain("1,234");
    expect(msg).toContain("coins");
  });

  it("checks another user's balance when the user option is supplied", async () => {
    getBalance.mockResolvedValue({ balance: 50 });
    const target = makeUser({ id: "u-target", username: "victim" });
    const interaction = makeInteraction({
      user: makeUser({ id: "u-self" }),
      options: { user: target },
    });
    await execute(interaction);
    expect(getBalance).toHaveBeenCalledWith("u-target");
    expect(getLastReplyContent(interaction)).toContain("victim");
  });

  it("falls back to 100 when balance is missing/undefined", async () => {
    getBalance.mockResolvedValue({}); // no balance field -> econ.balance?.toLocaleString() is undefined -> "100"
    const interaction = makeInteraction({ user: makeUser({ username: "newbie" }) });
    await execute(interaction);
    const msg = getLastReplyContent(interaction);
    expect(msg).toContain("**100**");
  });
});
