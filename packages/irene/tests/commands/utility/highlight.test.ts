import { describe, it, expect, vi, beforeEach } from "vitest";

// highlight.js imports saveHighlightDb from database.js and calls it on every
// mutation; stub the module so we don't touch a real DB.
const saveSpy = vi.fn();
vi.mock("../../../database.js", () => ({ saveHighlightDb: (...a: any[]) => saveSpy(...a) }));

// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, repliedText } from "../../_helpers/mockDiscord.js";

import * as highlight from "../../../commands/utility/highlight.js";

function hl(sub: string, opts: Record<string, any> = {}, user?: any, guild?: any) {
  user = user ?? makeUser();
  guild = guild ?? makeGuild();
  return makeInteraction({ user, guild, subcommand: sub, options: opts });
}

describe("utility/highlight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    highlight.highlightStore.clear();
  });

  it("declares the highlight command", () => {
    expect(highlight.data.name).toBe("highlight");
  });

  describe("add", () => {
    it("adds a word, confirms, and persists to the DB", async () => {
      const interaction = hl("add", { word: "Deploy" });
      await highlight.execute(interaction);

      expect(repliedText(interaction)).toContain("Highlight Added");
      // stored lowercased
      const key = `${interaction.guild.id}-${interaction.user.id}`;
      expect([...highlight.highlightStore.get(key)]).toContain("deploy");
      expect(saveSpy).toHaveBeenCalled();
    });

    it("refuses an 11th highlight (max 10)", async () => {
      const user = makeUser();
      const guild = makeGuild();
      for (let i = 0; i < 10; i++) {
        await highlight.execute(hl("add", { word: `word${i}` }, user, guild));
      }
      const overflow = hl("add", { word: "eleventh" }, user, guild);
      await highlight.execute(overflow);

      expect(repliedText(overflow)).toContain("Highlight Limit");
      const key = `${guild.id}-${user.id}`;
      expect(highlight.highlightStore.get(key).size).toBe(10);
    });
  });

  describe("remove", () => {
    it("removes an existing word", async () => {
      const user = makeUser();
      const guild = makeGuild();
      await highlight.execute(hl("add", { word: "alpha" }, user, guild));

      const rm = hl("remove", { word: "ALPHA" }, user, guild); // case-insensitive
      await highlight.execute(rm);
      expect(repliedText(rm)).toContain("Highlight Removed");
      expect(highlight.highlightStore.get(`${guild.id}-${user.id}`)).toBeUndefined();
    });

    it("reports Not Found for a word the user never added", async () => {
      const rm = hl("remove", { word: "ghost" });
      await highlight.execute(rm);
      expect(repliedText(rm)).toContain("Not Found");
    });
  });

  describe("list", () => {
    it("says there are no highlights when empty", async () => {
      const ls = hl("list");
      await highlight.execute(ls);
      expect(repliedText(ls)).toContain("No Highlights");
    });

    it("lists current highlights with a count footer", async () => {
      const user = makeUser();
      const guild = makeGuild();
      await highlight.execute(hl("add", { word: "one" }, user, guild));
      await highlight.execute(hl("add", { word: "two" }, user, guild));

      const ls = hl("list", {}, user, guild);
      await highlight.execute(ls);
      const text = repliedText(ls);
      expect(text).toContain("one");
      expect(text).toContain("two");
      expect(text).toContain("2/10");
    });
  });

  describe("clear", () => {
    it("removes all highlights and persists", async () => {
      const user = makeUser();
      const guild = makeGuild();
      await highlight.execute(hl("add", { word: "x" }, user, guild));
      saveSpy.mockClear();

      const clr = hl("clear", {}, user, guild);
      await highlight.execute(clr);
      expect(repliedText(clr)).toContain("Highlights Cleared");
      expect(highlight.highlightStore.has(`${guild.id}-${user.id}`)).toBe(false);
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  describe("checkHighlights", () => {
    // NOTE: checkHighlights parses each store key with `key.split("-")` and
    // treats element [0] as guildId and [1] as userId. Real Discord snowflakes
    // contain no hyphens, so we use hyphen-free numeric ids here to match the
    // source's parsing contract. (See "known fragility" note in the return.)
    it("DMs a watching, recently-active user when their word appears (whole-word match)", async () => {
      const watcher = makeUser({ id: "201", username: "watcher" });
      const guild = makeGuild({ id: "999" });
      // register a highlight AND record activity (add does both)
      await highlight.execute(hl("add", { word: "rocket" }, watcher, guild));

      const dmTarget = makeUser({ id: "201" });
      const client = {
        users: { fetch: vi.fn(async () => dmTarget) },
      };
      const author = makeUser({ id: "202", username: "author", bot: false });
      const message = {
        author,
        guild,
        client,
        content: "the rocket launched today",
        channel: { name: "general" },
        url: "https://discord.test/msg",
      };

      await highlight.checkHighlights(message);
      expect(client.users.fetch).toHaveBeenCalledWith("201");
      expect(dmTarget.send).toHaveBeenCalledTimes(1);
    });

    it("does NOT notify when the highlighted word is only a substring (whole-word match required)", async () => {
      const watcher = makeUser({ id: "301", username: "watcher" });
      const guild = makeGuild({ id: "888" });
      await highlight.execute(hl("add", { word: "cat" }, watcher, guild));

      const dmTarget = makeUser({ id: "301" });
      const client = { users: { fetch: vi.fn(async () => dmTarget) } };
      const message = {
        author: makeUser({ id: "302", username: "author", bot: false }),
        guild,
        client,
        content: "concatenate the strings", // "cat" appears only inside "concatenate"
        channel: { name: "general" },
        url: "https://discord.test/msg",
      };

      await highlight.checkHighlights(message);
      expect(dmTarget.send).not.toHaveBeenCalled();
    });

    it("ignores bot authors and DM (guild-less) messages", async () => {
      const watcher = makeUser({ id: "401", username: "w" });
      const guild = makeGuild({ id: "777" });
      await highlight.execute(hl("add", { word: "ping" }, watcher, guild));
      const client = { users: { fetch: vi.fn() } };

      await highlight.checkHighlights({ author: makeUser({ id: "402", bot: true }), guild, client, content: "ping", channel: { name: "c" } });
      await highlight.checkHighlights({ author: makeUser({ id: "403" }), guild: null, client, content: "ping", channel: { name: "c" } });

      expect(client.users.fetch).not.toHaveBeenCalled();
    });

    it("does not DM the message author about their own highlighted word", async () => {
      const author = makeUser({ id: "501", username: "self" });
      const guild = makeGuild({ id: "666" });
      await highlight.execute(hl("add", { word: "selfword" }, author, guild));
      const client = { users: { fetch: vi.fn(async () => author) } };

      await highlight.checkHighlights({
        author,
        guild,
        client,
        content: "talking about selfword now",
        channel: { name: "c" },
        url: "u",
      });
      // author is the same user that registered the highlight → skipped
      expect(client.users.fetch).not.toHaveBeenCalled();
    });
  });
});
