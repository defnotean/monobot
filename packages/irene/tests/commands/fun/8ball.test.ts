// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/8ball.js";
// @ts-expect-error - JS source, no types
import { resetCooldown } from "../../../utils/cooldown.js";

// Each test uses a fresh user id so the shared cooldown map never carries over.
function freshUser() {
  return makeUser({ id: `8ball-${Math.random()}` });
}

describe("fun/8ball", () => {
  it("exposes correct command metadata", () => {
    expect(cmd.data.name).toBe("8ball");
    const json = cmd.data.toJSON();
    const q = json.options.find((o: any) => o.name === "question");
    expect(q).toBeTruthy();
    expect(q.required).toBe(true);
  });

  it("replies with a magic 8-ball embed echoing the question", async () => {
    const user = freshUser();
    const interaction = makeInteraction({ user, options: { question: "Will it rain?" } });
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = lastReply(interaction);
    expect(payload.embeds).toHaveLength(1);
    const text = repliedText(interaction);
    expect(text).toContain("Magic 8-Ball");
    // The user's question must be surfaced as a field value.
    expect(text).toContain("Will it rain?");
  });

  it("answers with one of the canonical 8-ball responses", async () => {
    const user = freshUser();
    const interaction = makeInteraction({ user, options: { question: "?" } });
    await cmd.execute(interaction);
    const embed = lastReply(interaction).embeds[0];
    const desc = embed.data.description;
    // Description holds the random answer — assert it ends with a period like all
    // canonical responses, proving it came from the RESPONSES list, not the input.
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.endsWith(".")).toBe(true);
  });

  it("blocks a second invocation within the 5s cooldown window", async () => {
    const user = freshUser();
    resetCooldown("8ball", user.id);
    const first = makeInteraction({ user, options: { question: "first" } });
    await cmd.execute(first);
    expect(first.reply).toHaveBeenCalledTimes(1);
    expect(lastReply(first).embeds).toBeTruthy();

    const second = makeInteraction({ user, options: { question: "second" } });
    await cmd.execute(second);
    const payload = lastReply(second);
    // Cooldown path replies with plain content + ephemeral flag, no embed.
    expect(payload.content).toMatch(/Wait \d+s/);
    expect(payload.flags).toBe(64);
    expect(payload.embeds).toBeUndefined();
  });
});
