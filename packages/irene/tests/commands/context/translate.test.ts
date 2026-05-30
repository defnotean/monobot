// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const { provState, quickReplyMock } = vi.hoisted(() => {
  const provState = { impl: null };
  return {
    provState,
    quickReplyMock: vi.fn((...args) => provState.impl(...args)),
  };
});

vi.mock("../../../ai/providers/index.js", () => ({
  quickReply: quickReplyMock,
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import { quickReply } from "../../../ai/providers/index.js";
import { execute, data } from "../../../commands/context/translate.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeMessage,
  makeUser,
  repliedText,
  lastReply,
} from "../../_helpers/mockDiscord.js";

function ctxInteraction({ content = "hola amigo" } = {}) {
  const author = makeUser({ username: "speaker" });
  const interaction = makeInteraction({ options: {} });
  interaction.targetMessage = makeMessage({ content, author });
  return interaction;
}

beforeEach(() => {
  vi.clearAllMocks();
  provState.impl = vi.fn(async () => "hello friend");
});

describe("'translate' context command", () => {
  it("declares the translate context command", () => {
    expect(data.name).toBe("translate");
  });

  it("refuses a message with no text and never calls the model", async () => {
    const interaction = ctxInteraction({ content: "   " });
    await execute(interaction);
    expect(quickReplyMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/no text to translate/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("defers then posts the translation with original + translated sections", async () => {
    const interaction = ctxInteraction({ content: "bonjour" });
    await execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(quickReplyMock).toHaveBeenCalledTimes(1);
    // The system instruction tells the model to translate to English.
    const [, systemInstruction, userContent] = quickReplyMock.mock.calls[0];
    expect(systemInstruction).toMatch(/translation tool/i);
    expect(userContent).toBe("bonjour");
    const text = repliedText(interaction);
    expect(text).toMatch(/original/i);
    expect(text).toContain("bonjour");
    expect(text).toContain("hello friend");
  });

  it("handles an empty model response gracefully", async () => {
    provState.impl = vi.fn(async () => "   ");
    const interaction = ctxInteraction({ content: "ciao" });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/returned nothing/i);
  });

  it("reports a failure when the model throws", async () => {
    provState.impl = vi.fn(async () => {
      throw new Error("provider down");
    });
    const interaction = ctxInteraction({ content: "guten tag" });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/translation failed/i);
    expect(repliedText(interaction)).toContain("provider down");
  });
});
