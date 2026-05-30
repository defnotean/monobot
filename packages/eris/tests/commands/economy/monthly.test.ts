// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimMonthly = vi.fn();
vi.mock("../../../database.js", () => ({ claimMonthly: (...a: any[]) => claimMonthly(...a) }));

import { makeInteraction, makeUser, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";

let execute: any;
let data: any;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ execute, data } = await import("../../../commands/economy/monthly.js"));
});

describe("economy/monthly", () => {
  it("registers a /monthly command", () => {
    expect(data.toJSON().name).toBe("monthly");
  });

  it("reports a successful monthly claim", async () => {
    claimMonthly.mockResolvedValue({ success: true, coins: 5000, streak: 1, newBalance: 50000 });
    const interaction = makeInteraction({ user: makeUser({ id: "uM" }) });
    await execute(interaction);
    expect(claimMonthly).toHaveBeenCalledWith("uM");
    const msg = getLastReplyContent(interaction);
    expect(msg).toContain("5000");
    expect(msg).toContain("monthly coins");
    expect(msg).toContain("50,000");
  });

  it("shows cooldown ephemerally", async () => {
    claimMonthly.mockResolvedValue({ success: false, hoursLeft: 200 });
    const interaction = makeInteraction();
    await execute(interaction);
    const last = getLastReply(interaction);
    expect(last?.content).toContain("come back in **200h**");
    expect(last?.payload.flags).toBeDefined();
  });

  it("shows save-failure ephemerally on claim_failed", async () => {
    claimMonthly.mockResolvedValue({ success: false, error: "claim_failed" });
    const interaction = makeInteraction();
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toContain("something went wrong");
    expect(getLastReply(interaction)?.payload.flags).toBeDefined();
  });
});
