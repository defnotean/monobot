// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/rps.js";
// @ts-expect-error - JS source, no types
import { resetCooldown } from "../../../utils/cooldown.js";

function freshUser() {
  return makeUser({ id: `rps-${Math.random()}` });
}

// CHOICES = ["rock","paper","scissors"]; bot index = floor(random*3).
function mockBotChoice(index: number) {
  // index 0 -> rock, 1 -> paper, 2 -> scissors
  vi.spyOn(Math, "random").mockReturnValue(index / 3 + 0.01);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fun/rps", () => {
  it("requires a choice option restricted to rock/paper/scissors", () => {
    const json = cmd.data.toJSON();
    const choice = json.options.find((o: any) => o.name === "choice");
    expect(choice.required).toBe(true);
    expect(choice.choices.map((c: any) => c.value).sort()).toEqual(["paper", "rock", "scissors"]);
  });

  it("reports a tie when both pick the same", async () => {
    mockBotChoice(0); // bot rock
    const interaction = makeInteraction({ user: freshUser(), options: { choice: "rock" } });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("It's a Tie!");
  });

  it("reports a win when user beats bot (rock vs scissors)", async () => {
    mockBotChoice(2); // bot scissors
    const interaction = makeInteraction({ user: freshUser(), options: { choice: "rock" } });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("You Win!");
  });

  it("reports a loss when bot beats user (rock vs paper)", async () => {
    mockBotChoice(1); // bot paper
    const interaction = makeInteraction({ user: freshUser(), options: { choice: "rock" } });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("You Lose!");
  });

  it("enforces the 5s cooldown", async () => {
    const user = freshUser();
    resetCooldown("rps", user.id);
    mockBotChoice(0);
    await cmd.execute(makeInteraction({ user, options: { choice: "rock" } }));
    const second = makeInteraction({ user, options: { choice: "rock" } });
    await cmd.execute(second);
    expect(lastReply(second).content).toMatch(/Wait \d+s/);
  });
});
