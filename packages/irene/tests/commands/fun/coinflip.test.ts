// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/coinflip.js";
// @ts-expect-error - JS source, no types
import { resetCooldown } from "../../../utils/cooldown.js";

function freshUser() {
  return makeUser({ id: `coinflip-${Math.random()}` });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fun/coinflip", () => {
  it("has the expected command name and no options", () => {
    expect(cmd.data.name).toBe("coinflip");
    expect(cmd.data.toJSON().options ?? []).toHaveLength(0);
  });

  it("replies Heads when RNG < 0.5", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const interaction = makeInteraction({ user: freshUser() });
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toContain("Heads");
  });

  it("replies Tails when RNG >= 0.5", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const interaction = makeInteraction({ user: freshUser() });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("Tails");
  });

  it("enforces the 3s cooldown on rapid reuse", async () => {
    const user = freshUser();
    resetCooldown("coinflip", user.id);
    await cmd.execute(makeInteraction({ user }));

    const second = makeInteraction({ user });
    await cmd.execute(second);
    const payload = lastReply(second);
    expect(payload.content).toMatch(/Wait \d+s/);
    expect(payload.flags).toBe(64);
  });
});
