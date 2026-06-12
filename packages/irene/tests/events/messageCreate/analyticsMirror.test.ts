// mirrorToDm truthiness fix (audit F7): the Gemini lane reports toolsUsed as
// a boolean while the OpenAI-compat lane returns an ARRAY of tool names. An
// empty array is truthy, so every compat reply used to DM-mirror even when no
// tool ran. toolsUsed now counts as "used" only when the array is non-empty.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getDmResults: vi.fn(() => true),
  isDmOptout: vi.fn(() => false),
}));

vi.mock("discord.js", () => ({ MessageFlags: { SuppressEmbeds: 4 } }));
vi.mock("../../../config.js", () => ({ default: { ownerId: "owner-1" } }));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../database.js", () => ({
  getMood: vi.fn(() => ({ energy: 100 })),
  getGuildSettings: vi.fn(() => ({})),
  isDmOptout: h.isDmOptout,
  getDmResults: h.getDmResults,
}));
vi.mock("../../../events/messageCreate/gates.js", () => ({
  markBotResponded: vi.fn(),
  isSleeping: vi.fn(() => false),
  triggerSleep: vi.fn(),
  SLEEP_TRIGGERS: /never-match-sleep/,
  NAP_TRIGGERS: /never-match-nap/,
}));
vi.mock("../../../events/messageCreate/aiInvoke.js", () => ({
  getConvClient: vi.fn(() => null),
  activeProviderNeedsGeminiClient: vi.fn(() => false),
}));
vi.mock("../../../ai/executors/customCommandExecutor.js", () => ({
  validateAssignableRole: vi.fn(() => null),
}));

// @ts-expect-error JS module without types
import { mirrorToDm } from "../../../events/messageCreate/analytics.js";

function mirrorArgs(toolsUsed: unknown) {
  const send = vi.fn(async () => {});
  const args = {
    toolsUsed,
    isDM: false,
    guild: { id: "guild-1" },
    message: { author: { id: "user-1", createDM: vi.fn(async () => ({ send })) } },
    chunks: ["result chunk"],
  };
  return { args, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getDmResults.mockReturnValue(true);
  h.isDmOptout.mockReturnValue(false);
});

describe("mirrorToDm toolsUsed truthiness", () => {
  it("does NOT mirror when the compat lane reports an empty toolsUsed array", async () => {
    const { args, send } = mirrorArgs([]);
    await mirrorToDm(args);
    expect(args.message.author.createDM).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("mirrors when the compat lane reports a non-empty toolsUsed array", async () => {
    const { args, send } = mirrorArgs(["web_search"]);
    await mirrorToDm(args);
    expect(args.message.author.createDM).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ content: "result chunk", flags: 4 });
  });

  it("mirrors when the Gemini lane reports toolsUsed=true", async () => {
    const { args, send } = mirrorArgs(true);
    await mirrorToDm(args);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does NOT mirror when the Gemini lane reports toolsUsed=false", async () => {
    const { args, send } = mirrorArgs(false);
    await mirrorToDm(args);
    expect(send).not.toHaveBeenCalled();
  });

  it("still honors the per-user DM opt-out", async () => {
    h.isDmOptout.mockReturnValue(true);
    const { args, send } = mirrorArgs(["web_search"]);
    await mirrorToDm(args);
    expect(send).not.toHaveBeenCalled();
  });
});
