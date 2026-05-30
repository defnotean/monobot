// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimDaily = vi.fn();
vi.mock("../../../database.js", () => ({ claimDaily: (...a: any[]) => claimDaily(...a) }));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/daily.js"));
});

describe("economy/daily", () => {
  it("registers a /daily command", () => {
    expect(data.toJSON().name).toBe("daily");
  });

  it("reports a successful claim with coins, streak and new balance", async () => {
    claimDaily.mockResolvedValue({ success: true, coins: 250, streak: 3, newBalance: 12345 });
    const interaction = makeInteraction({ user: makeUser({ id: "u1" }) });
    await execute(interaction);
    expect(claimDaily).toHaveBeenCalledWith("u1");
    const msg = getLastReplyContent(interaction);
    expect(msg).toContain("250");
    expect(msg).toContain("streak: **3**");
    expect(msg).toContain("12,345");
  });

  it("shows cooldown remaining ephemerally when on cooldown", async () => {
    claimDaily.mockResolvedValue({ success: false, hoursLeft: 7 });
    const interaction = makeInteraction();
    await execute(interaction);
    const last = getLastReply(interaction);
    expect(last?.content).toContain("come back in **7h**");
    expect(last?.payload.flags).toBeDefined();
  });

  it("shows a save-failure message ephemerally on claim_failed", async () => {
    claimDaily.mockResolvedValue({ success: false, error: "claim_failed" });
    const interaction = makeInteraction();
    await execute(interaction);
    const last = getLastReply(interaction);
    expect(last?.content).toContain("something went wrong");
    expect(last?.payload.flags).toBeDefined();
  });
});
