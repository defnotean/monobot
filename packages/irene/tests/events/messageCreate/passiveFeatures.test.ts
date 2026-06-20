import { describe, expect, it, vi } from "vitest";

vi.mock("../../../config.js", () => ({ default: { ownerId: "OWNER_ID" } }));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTtsChannels: vi.fn(() => []) }));
vi.mock("../../../ai/executors/customCommandExecutor.js", () => ({ validateAssignableRole: vi.fn() }));
const buildTikTokFixReply = vi.hoisted(() => vi.fn());
vi.mock("@defnotean/shared/tiktokLinkFixer", () => ({ buildTikTokFixReply }));
vi.mock("@defnotean/shared/safeFetch", () => ({ safeFetch: vi.fn() }));
vi.mock("../../../events/messageCreate/gates.js", () => ({
  isSleeping: vi.fn(() => false),
  wakeSleep: vi.fn(),
}));
vi.mock("../../../events/messageCreate/commandPrefix.js", () => ({
  processStickyMessage: vi.fn(),
  processAutoResponders: vi.fn(),
}));

import { detectTtsToggleShortcut, maybeFixTikTokLinks } from "../../../events/messageCreate/passiveFeatures.js";

describe("detectTtsToggleShortcut", () => {
  it("treats 'back on' as enabling TTS", () => {
    expect(detectTtsToggleShortcut("Irene turn tts back on")).toBe(true);
    expect(detectTtsToggleShortcut("switch text to speech back on")).toBe(true);
  });

  it("treats 'back off' as disabling TTS", () => {
    expect(detectTtsToggleShortcut("turn tts back off")).toBe(false);
    expect(detectTtsToggleShortcut("switch back off text-to-speech")).toBe(false);
  });

  it("does not confuse voice listening with TTS", () => {
    expect(detectTtsToggleShortcut("turn voice listen on in vc")).toBeNull();
  });
});

describe("maybeFixTikTokLinks", () => {
  it("replies with the fixed TikTok embed payload", async () => {
    const reply = vi.fn(async () => {});
    buildTikTokFixReply.mockResolvedValueOnce({
      content: "fixed tiktok embed:\nhttps://www.vxtiktok.com/@u/video/1",
      allowedMentions: { parse: [] },
    });

    await expect(maybeFixTikTokLinks({
      author: { bot: false },
      content: "https://www.tiktok.com/@u/video/1",
      reply,
    })).resolves.toBe(true);

    expect(reply).toHaveBeenCalledWith({
      content: "fixed tiktok embed:\nhttps://www.vxtiktok.com/@u/video/1",
      allowedMentions: { parse: [] },
    });
  });

  it("ignores non-TikTok messages", async () => {
    const reply = vi.fn();
    buildTikTokFixReply.mockResolvedValueOnce(null);

    await expect(maybeFixTikTokLinks({
      author: { bot: false },
      content: "hello",
      reply,
    })).resolves.toBe(false);

    expect(reply).not.toHaveBeenCalled();
  });
});
