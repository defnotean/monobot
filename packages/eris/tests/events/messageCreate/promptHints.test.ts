import { describe, it, expect, vi, beforeEach } from "vitest";

const { logSpy, slangSpy } = vi.hoisted(() => ({
  logSpy: vi.fn(),
  slangSpy: vi.fn(() => ""),
}));

vi.mock("../../../utils/logger.js", () => ({ log: logSpy }));
// buildPromptHints dynamically imports the shared slangGuard; stub it so we
// isolate the keyword-hint branches under test.
vi.mock("@defnotean/shared/slangGuard.js", () => ({
  getSlangGuardContext: slangSpy,
}));

// @ts-expect-error - importing JS module without types
import { buildPromptHints } from "../../../events/messageCreate/promptHints.js";

const client = { user: { username: "eris" } };
const ireneClient = { user: { username: "Irene" } };

const hints = (cleanMessage: string, opts: any = {}) =>
  buildPromptHints({ cleanMessage, client: opts.client ?? client, isAwaitedReply: opts.isAwaitedReply ?? false });

beforeEach(() => {
  logSpy.mockReset();
  slangSpy.mockReset();
  slangSpy.mockReturnValue("");
});

describe("buildPromptHints", () => {
  it("returns an empty string for ordinary chat", async () => {
    expect(await hints("just saying hi how are you")).toBe("");
  });

  it("prepends slang-guard context when present", async () => {
    slangSpy.mockReturnValue("[SLANG: word means X]");
    const out = await hints("some message");
    expect(out).toContain("[SLANG: word means X]");
  });

  it("survives a slang-guard import/throw and still returns other hints", async () => {
    slangSpy.mockImplementation(() => {
      throw new Error("boom");
    });
    const out = await hints("can you help me with this bet of 50");
    expect(out).toContain("gamble/play a game");
    expect(logSpy).toHaveBeenCalled();
  });

  it("adds a code-review hint when code-ish content is shared", async () => {
    expect(await hints("here is a snippet: const x = 1")).toContain("user shared code");
    expect(await hints("```\nfn()\n```")).toContain("user shared code");
  });

  it("adds the gentle crisis-support hint for genuinely alarming messages", async () => {
    const out = await hints("i want to die honestly");
    expect(out).toContain("genuinely alarming");
  });

  it("uses the anti-therapy-bot hint for a mere negative emotion word", async () => {
    const out = await hints("im a little stressed about the math problem");
    expect(out).toContain("ANTI-THERAPY-BOT");
    expect(out).not.toContain("genuinely alarming");
  });

  it("adds the gambling hint for game/bet keywords", async () => {
    expect(await hints("lets flip for 100 coins")).toContain("gamble/play a game");
  });

  it("adds the bump-reminder config hint", async () => {
    expect(await hints("help me set up bump reminder")).toContain("DISBOARD bump reminder");
  });

  it("adds the game-tracking hint for patch-note tracking requests", async () => {
    expect(await hints("can you track updates for this game")).toContain("game update tracking");
  });

  it("only adds the karaoke hint when the bot is Irene", async () => {
    expect(await hints("sing me a song", { client })).not.toContain("karaoke");
    expect(await hints("sing me a song", { client: ireneClient })).toContain("karaoke");
  });

  it("adds the awaited-reply follow-up hint when isAwaitedReply is true", async () => {
    const out = await hints("yeah", { isAwaitedReply: true });
    expect(out).toContain("follow-up reply to your previous question");
  });
});
