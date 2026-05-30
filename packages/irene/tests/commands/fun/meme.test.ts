// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply, getReplies } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/meme.js";
// @ts-expect-error - JS source, no types
import { resetCooldown } from "../../../utils/cooldown.js";

function freshUser() {
  return makeUser({ id: `meme-${Math.random()}` });
}

function fetchResolving(value: any, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => value }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fun/meme", () => {
  it("is named meme with no options", () => {
    expect(cmd.data.name).toBe("meme");
    expect(cmd.data.toJSON().options ?? []).toHaveLength(0);
  });

  it("defers then edits with an image embed on a valid API response", async () => {
    const user = freshUser();
    resetCooldown("meme", user.id);
    global.fetch = fetchResolving({ url: "https://i.redd.it/x.png", title: "Funny", subreddit: "memes", ups: 5 });
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const embed = lastReply(interaction).embeds[0];
    expect(embed.data.title).toBe("Funny");
    expect(embed.data.image.url).toBe("https://i.redd.it/x.png");
    expect(embed.data.footer.text).toContain("r/memes");
  });

  it("edits with an API Error embed after exhausting retries on non-ok responses", async () => {
    const user = freshUser();
    resetCooldown("meme", user.id);
    global.fetch = fetchResolving({}, false); // every fetch returns !ok
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);

    // 2 retries on !ok.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(repliedText(interaction)).toContain("API Error");
  });

  it("rejects payloads missing url/title", async () => {
    const user = freshUser();
    resetCooldown("meme", user.id);
    global.fetch = fetchResolving({ subreddit: "memes" }); // ok but no url/title
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("Couldn't find a valid meme");
  });

  it("rejects an invalid (non-URL) meme url", async () => {
    const user = freshUser();
    resetCooldown("meme", user.id);
    global.fetch = fetchResolving({ url: "not a url", title: "t" });
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("Invalid meme URL");
  });

  it("falls back to error embed when fetch throws", async () => {
    const user = freshUser();
    resetCooldown("meme", user.id);
    global.fetch = vi.fn(async () => { throw new Error("network down"); });
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("Failed to fetch meme");
  });

  it("short-circuits with a cooldown reply (no defer/fetch) when on cooldown", async () => {
    const user = freshUser();
    resetCooldown("meme", user.id);
    global.fetch = fetchResolving({ url: "https://i.redd.it/x.png", title: "ok" });
    await cmd.execute(makeInteraction({ user }));

    const second = makeInteraction({ user });
    const callsBefore = (global.fetch as any).mock.calls.length;
    await cmd.execute(second);
    expect(second.deferReply).not.toHaveBeenCalled();
    expect((global.fetch as any).mock.calls.length).toBe(callsBefore); // no new fetch
    expect(lastReply(second).content).toMatch(/Wait \d+s/);
  });
});
