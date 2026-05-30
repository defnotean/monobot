// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// A single fake gemini model whose generateContent is controllable per-test.
// vi.hoisted so these are initialized before the hoisted vi.mock factory runs.
const { genState, generateContentMock } = vi.hoisted(() => {
  const genState = { impl: null };
  const generateContentMock = vi.fn((...args) => genState.impl(...args));
  return { genState, generateContentMock };
});

// Mock the Google GenAI SDK so constructing a client yields our fake model.
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      this.models = { generateContent: generateContentMock };
    }
  },
}));

// chat.js reads config.geminiKeys at import-time to build the client pool.
vi.mock("../../../config.js", () => ({
  default: {
    geminiKeys: ["fake-key-1"],
    botPersonality: "You are Irene.",
    aiCooldownMs: 3000,
  },
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import { execute, data } from "../../../commands/ai/chat.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  repliedText,
  lastReply,
  getReplies,
} from "../../_helpers/mockDiscord.js";

function reply(text) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  genState.impl = vi.fn(async () => reply("hello from irene"));
});

describe("/chat", () => {
  it("declares the chat command", () => {
    expect(data.name).toBe("chat");
  });

  it("rejects input over the max length without calling the model", async () => {
    const interaction = makeInteraction({
      options: { message: "x".repeat(2001) },
    });
    await execute(interaction);
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/too long/i);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("defers, calls the model, and edits in the reply", async () => {
    const interaction = makeInteraction({
      options: { message: "hi there" },
    });
    await execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const callArg = generateContentMock.mock.calls[0][0];
    expect(callArg.contents[0].parts[0].text).toBe("hi there");
    expect(callArg.config.systemInstruction).toBe("You are Irene.");
    expect(repliedText(interaction)).toContain("hello from irene");
  });

  it("filters out thought parts from the model response", async () => {
    genState.impl = vi.fn(async () => ({
      candidates: [
        {
          content: {
            parts: [
              { text: "internal reasoning", thought: true },
              { text: "visible answer" },
            ],
          },
        },
      ],
    }));
    const interaction = makeInteraction({ options: { message: "q" } });
    await execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("visible answer");
    expect(text).not.toContain("internal reasoning");
  });

  it("enforces a per-user cooldown after a successful request", async () => {
    const interaction1 = makeInteraction({ options: { message: "first" } });
    await execute(interaction1);
    expect(generateContentMock).toHaveBeenCalledTimes(1);

    // Reuse the same guild + user so the cooldown key matches.
    const interaction2 = makeInteraction({
      options: { message: "second" },
      user: interaction1.user,
      guild: interaction1.guild,
    });
    await execute(interaction2);
    // Cooldown blocks the second call; model not invoked again.
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction2)).toMatch(/cooldown/i);
  });

  it("does NOT set the cooldown when the model throws (failures are retryable)", async () => {
    genState.impl = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const interaction = makeInteraction({ options: { message: "boom" } });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/something went wrong/i);

    // A second call with the same identity should still reach the model
    // (cooldown was not consumed by the failed request).
    genState.impl = vi.fn(async () => reply("recovered"));
    const interaction2 = makeInteraction({
      options: { message: "retry" },
      user: interaction.user,
      guild: interaction.guild,
    });
    await execute(interaction2);
    expect(repliedText(interaction2)).toContain("recovered");
  });
});
