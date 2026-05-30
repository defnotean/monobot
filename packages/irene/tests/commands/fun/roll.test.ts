// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/roll.js";
// @ts-expect-error - JS source, no types
import { resetCooldown } from "../../../utils/cooldown.js";

function freshUser() {
  return makeUser({ id: `roll-${Math.random()}` });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fun/roll", () => {
  it("declares sides and count integer options with min/max bounds", () => {
    const json = cmd.data.toJSON();
    const sides = json.options.find((o: any) => o.name === "sides");
    const count = json.options.find((o: any) => o.name === "count");
    expect(sides.min_value).toBe(2);
    expect(sides.max_value).toBe(100);
    expect(count.min_value).toBe(1);
    expect(count.max_value).toBe(10);
  });

  it("rolls a single d6 by default and reports the value", async () => {
    // Build the user id BEFORE mocking Math.random (freshUser uses it for a
    // unique id; mocking it to 0 first would collide ids across tests and trip
    // the shared cooldown).
    const user = freshUser();
    // Math.random()*6 -> 0 means a roll of 1.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("You rolled a **1**");
    expect(text).toContain("d6");
  });

  it("rolls multiple custom-sided dice and totals them", async () => {
    const user = freshUser();
    // random=0 -> each die rolls 1; 3 dice on a d20 -> total 3.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const interaction = makeInteraction({ user, options: { sides: 20, count: 3 } });
    await cmd.execute(interaction);
    const embed = lastReply(interaction).embeds[0];
    const fields = embed.data.fields;
    const total = fields.find((f: any) => f.name === "Total");
    const formula = fields.find((f: any) => f.name === "Formula");
    expect(total.value).toBe("3");
    expect(formula.value).toBe("3d20");
  });

  it("blocks reuse within the 3s cooldown", async () => {
    const user = freshUser();
    resetCooldown("roll", user.id);
    await cmd.execute(makeInteraction({ user }));
    const second = makeInteraction({ user });
    await cmd.execute(second);
    expect(lastReply(second).content).toMatch(/Wait \d+s/);
    expect(lastReply(second).flags).toBe(64);
  });
});
