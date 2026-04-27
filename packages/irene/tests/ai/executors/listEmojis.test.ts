// ─── REFERENCE TOOL TEST ─── Mirror this shape when testing a new tool. ───
//
// Pattern this file demonstrates:
//   1. Pick a real tool name and dispatch through the public entry point
//      (executeTool) — same path the AI takes at runtime, so we exercise
//      router + handler together. No private internals.
//   2. Build a minimal fake `message` (author + guild) — only stub the
//      Discord.js surface the handler actually touches. For list_emojis
//      that's just `guild.emojis.cache`.
//   3. Cover the handler's contract: empty input, populated input,
//      and any branching the handler does (here: animated vs static).
//   4. Use unique guild/user IDs per test so the executor's read-tool
//      cache (keyed by guildId+toolName+args) doesn't bleed results
//      between tests.
//
// See packages/irene/ai/tools.js:1902 for the schema this tests.
// See packages/irene/ai/executor.js:1510 for the handler.

import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { executeTool } from "../../../ai/executor.js";

// Builds a fake Discord.js Collection-like object — only the methods
// list_emojis actually uses (`.size` and `.map`). Real Collection has
// hundreds more, but the handler only needs these two.
function fakeEmojiCache(emojis: Array<{ name: string; id: string; animated: boolean }>) {
  return {
    size: emojis.length,
    map: <T>(fn: (e: typeof emojis[number]) => T) => emojis.map(fn),
  };
}

// Builds the minimal `message` the executor reads: author for rate-limit
// keying, guild for handler logic. Use a unique guildId per test to
// dodge the 15-second tool result cache in executor.js.
function fakeMessage(guildId: string, emojiCache: ReturnType<typeof fakeEmojiCache>) {
  return {
    author: { id: `user-${guildId}`, username: "tester" },
    guild: { id: guildId, emojis: { cache: emojiCache } },
  };
}

describe("list_emojis (REFERENCE TOOL)", () => {
  it("returns 'No custom emojis' when the server has none", async () => {
    const msg = fakeMessage("g-empty", fakeEmojiCache([]));
    const result = await executeTool("list_emojis", {}, msg);
    expect(result).toBe("No custom emojis");
  });

  it("formats a static emoji as :name: — id", async () => {
    const msg = fakeMessage("g-static", fakeEmojiCache([
      { name: "pepe", id: "111", animated: false },
    ]));
    const result = await executeTool("list_emojis", {}, msg);
    expect(result).toBe(":pepe: — 111");
  });

  it("prefixes animated emojis with '(animated) '", async () => {
    const msg = fakeMessage("g-animated", fakeEmojiCache([
      { name: "wave", id: "222", animated: true },
    ]));
    const result = await executeTool("list_emojis", {}, msg);
    expect(result).toBe("(animated) :wave: — 222");
  });

  it("joins multiple emojis with newlines, preserving order", async () => {
    const msg = fakeMessage("g-multi", fakeEmojiCache([
      { name: "a", id: "1", animated: false },
      { name: "b", id: "2", animated: true },
      { name: "c", id: "3", animated: false },
    ]));
    const result = await executeTool("list_emojis", {}, msg);
    expect(result).toBe(":a: — 1\n(animated) :b: — 2\n:c: — 3");
  });
});
