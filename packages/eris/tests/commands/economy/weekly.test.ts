// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimWeekly = vi.fn();
vi.mock("../../../database.js", () => ({ claimWeekly: (...a: any[]) => claimWeekly(...a) }));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/weekly.js"));
});

describe("economy/weekly", () => {
  it("registers a /weekly command", () => {
    expect(data.toJSON().name).toBe("weekly");
  });

  it("reports a successful weekly claim", async () => {
    claimWeekly.mockResolvedValue({ success: true, coins: 1000, streak: 2, newBalance: 9999 });
    const interaction = makeInteraction({ user: makeUser({ id: "uW" }) });
    await execute(interaction);
    expect(claimWeekly).toHaveBeenCalledWith("uW");
    const msg = getLastReplyContent(interaction);
    expect(msg).toContain("1000");
    expect(msg).toContain("weekly coins");
    expect(msg).toContain("streak: **2**");
    expect(msg).toContain("9,999");
  });

  it("shows cooldown ephemerally", async () => {
    claimWeekly.mockResolvedValue({ success: false, hoursLeft: 48 });
    const interaction = makeInteraction();
    await execute(interaction);
    const last = getLastReply(interaction);
    expect(last?.content).toContain("come back in **48h**");
    expect(last?.payload.flags).toBeDefined();
  });

  it("shows save-failure ephemerally on claim_failed", async () => {
    claimWeekly.mockResolvedValue({ success: false, error: "claim_failed" });
    const interaction = makeInteraction();
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toContain("something went wrong");
    expect(getLastReply(interaction)?.payload.flags).toBeDefined();
  });
});
