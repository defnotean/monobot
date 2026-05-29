import { describe, it, expect, vi, beforeEach } from "vitest";

// Task 1 (a): when a claim returns { success:false, error:"claim_failed" } (the
// fail-closed transient path — DB stamp write failed, or persistence has gone
// dark), each CALLER must render a clear transient-error message rather than the
// cooldown template, which previously printed "come back in **undefinedh**"
// because result.hoursLeft is undefined on the claim_failed path.

// The claim result the mocked database returns. Mutated per-case.
let claimResult: any = { success: false, error: "claim_failed" };

// The slash commands import the named claim fn from ../../database.js; the misc
// executor imports `* as db`. Stub all three claim fns off the same module mock.
vi.mock("../../database.js", () => ({
  claimDaily: () => Promise.resolve(claimResult),
  claimWeekly: () => Promise.resolve(claimResult),
  claimMonthly: () => Promise.resolve(claimResult),
}));

// SlashCommandBuilder is instantiated at command-module load; give it a chainable
// stub. MessageFlags.Ephemeral just needs to be a value the reply carries.
vi.mock("discord.js", () => {
  class SlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
  }
  return { SlashCommandBuilder, MessageFlags: { Ephemeral: 64 } };
});

// @ts-expect-error - importing JS module without types
import { execute as dailyExecute } from "../../commands/economy/daily.js";
// @ts-expect-error - importing JS module without types
import { execute as weeklyExecute } from "../../commands/economy/weekly.js";
// @ts-expect-error - importing JS module without types
import { execute as monthlyExecute } from "../../commands/economy/monthly.js";
// @ts-expect-error - importing JS module without types
import { execute as miscExecute } from "../../ai/executors/miscExecutor.js";

function fakeInteraction() {
  const replies: any[] = [];
  return {
    user: { id: "u1" },
    reply: (arg: any) => { replies.push(arg); return Promise.resolve(); },
    replies,
  } as any;
}

describe("claim callers render a transient message (not undefinedh) on claim_failed", () => {
  beforeEach(() => {
    claimResult = { success: false, error: "claim_failed" };
  });

  for (const [name, exec] of [
    ["daily", dailyExecute],
    ["weekly", weeklyExecute],
    ["monthly", monthlyExecute],
  ] as const) {
    it(`/${name} renders the transient-error message`, async () => {
      const interaction = fakeInteraction();
      await exec(interaction);
      const content = interaction.replies[0].content as string;
      expect(content).not.toContain("undefinedh");
      expect(content).not.toContain("come back in");
      expect(content.toLowerCase()).toContain("something went wrong");
    });

    it(`/${name} still renders the cooldown template when a real cooldown is active`, async () => {
      claimResult = { success: false, hoursLeft: 12 };
      const interaction = fakeInteraction();
      await exec(interaction);
      const content = interaction.replies[0].content as string;
      expect(content).toContain("12h");
      expect(content).not.toContain("undefined");
    });
  }

  it("misc executor daily_reward renders the transient message on claim_failed", async () => {
    const sent: any[] = [];
    const message = {
      author: { id: "u1" },
      channel: { send: (a: any) => { sent.push(a); return Promise.resolve(); } },
    } as any;
    const result = await miscExecute("daily_reward", {}, message, {});
    expect(result).not.toContain("undefinedh");
    expect(result).not.toMatch(/come back in ~?undefined/);
    expect(String(result).toLowerCase()).toContain("something went wrong");
    // Nothing should be sent to the channel on the transient-failure path.
    expect(sent.length).toBe(0);
  });

  it("misc executor daily_reward still renders the cooldown text on a real cooldown", async () => {
    claimResult = { success: false, hoursLeft: 8 };
    const message = {
      author: { id: "u1" },
      channel: { send: () => Promise.resolve() },
    } as any;
    const result = await miscExecute("daily_reward", {}, message, {});
    expect(result).toContain("8h");
    expect(result).not.toContain("undefined");
  });
});
