import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { makeInteraction } from "../../_helpers/mockDiscord.js";

// Mock the hangman engine so we can drive createState() to throw (the only
// synchronous branch reachable before the async collector) and, for the happy
// path, hand back a controlled state.
const { createState, applyMove, renderBoard } = vi.hoisted(() => ({
  createState: vi.fn(),
  applyMove: vi.fn(),
  renderBoard: vi.fn(),
}));
vi.mock("../../../ai/games/hangman.js", () => ({ createState, applyMove, renderBoard }));

import { execute, data } from "../../../commands/games/hangman.js";

function lastReply(interaction: any) {
  const calls = interaction.reply.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

describe("hangman command", () => {
  beforeEach(() => {
    createState.mockReset();
    applyMove.mockReset();
    renderBoard.mockReset().mockReturnValue("_ _ _");
  });
  afterEach(() => vi.restoreAllMocks());

  it("declares the hangman command", () => {
    expect(data.name).toBe("hangman");
  });

  it("replies ephemerally when the engine fails to start", async () => {
    createState.mockImplementation(() => {
      throw new Error("empty word list");
    });
    const interaction = makeInteraction({ commandName: "hangman" });
    await execute(interaction);

    const reply = lastReply(interaction);
    expect(reply.content).toContain("could not start");
    expect(reply.content).toContain("empty word list");
    // Failure short-circuits before any fetchReply/collector setup.
    expect(interaction.fetchReply).not.toHaveBeenCalled();
  });

  it("sends a non-error game embed (not the 'could not start' error) when the engine succeeds", async () => {
    createState.mockReturnValue({ word: "CAT", guessed: new Set(), won: false, lost: false });
    // The post-reply wiring does fetchReply().createMessageComponentCollector;
    // give the fetched message a collector stub so that chain resolves cleanly.
    const collector = { on: vi.fn() };
    const interaction = makeInteraction({ commandName: "hangman" });
    (interaction.fetchReply as any).mockResolvedValue({
      createMessageComponentCollector: vi.fn(() => collector),
    });
    await execute(interaction);

    // Core effect of the success branch: an embed game reply was sent rather
    // than the ephemeral "could not start" text the catch branch produces.
    expect(interaction.reply).toHaveBeenCalled();
    const reply = lastReply(interaction);
    expect(reply.embeds).toBeDefined();
    // Distinguishes this from the error path, whose reply is { content, flags }.
    expect(reply.content ?? null).toBeNull();
  });
});
