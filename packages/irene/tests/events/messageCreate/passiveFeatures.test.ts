import { describe, expect, it, vi } from "vitest";

vi.mock("../../../config.js", () => ({ default: { ownerId: "OWNER_ID" } }));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../database.js", () => ({ getTtsChannels: vi.fn(() => []) }));
vi.mock("../../../ai/executors/customCommandExecutor.js", () => ({ validateAssignableRole: vi.fn() }));
vi.mock("../../../events/messageCreate/gates.js", () => ({
  isSleeping: vi.fn(() => false),
  wakeSleep: vi.fn(),
}));
vi.mock("../../../events/messageCreate/commandPrefix.js", () => ({
  processStickyMessage: vi.fn(),
  processAutoResponders: vi.fn(),
}));

import { detectTtsToggleShortcut } from "../../../events/messageCreate/passiveFeatures.js";

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
