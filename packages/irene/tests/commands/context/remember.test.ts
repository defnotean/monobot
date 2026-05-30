// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// remember.js dynamically imports ../../ai/memory.js inside loadMemoryApi().
const memState = { existing: [], addThrows: false };
const addMemoryMock = vi.fn(() => {
  if (memState.addThrows) throw new Error("db locked");
});
const getMemoriesMock = vi.fn(() => memState.existing);

vi.mock("../../../ai/memory.js", () => ({
  addMemory: addMemoryMock,
  getMemories: getMemoriesMock,
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import { execute, data } from "../../../commands/context/remember.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeMessage,
  makeUser,
  repliedText,
  lastReply,
} from "../../_helpers/mockDiscord.js";

beforeEach(() => {
  vi.clearAllMocks();
  memState.existing = [];
  memState.addThrows = false;
});

// Build a message-context interaction (targetMessage + guildId).
function ctxInteraction({ content = "remember this fact", author, guildId = "g1" } = {}) {
  const user = makeUser({ username: "invoker", id: "invoker-id" });
  const targetAuthor = author ?? makeUser({ username: "speaker", id: "speaker-id" });
  const interaction = makeInteraction({ user, options: {} });
  interaction.guildId = guildId;
  interaction.targetMessage = makeMessage({ content, author: targetAuthor });
  return { interaction, user, targetAuthor };
}

describe("'remember this' context command", () => {
  it("declares the context command", () => {
    expect(data.name).toBe("remember this");
  });

  it("refuses an empty target message", async () => {
    const { interaction } = ctxInteraction({ content: "   " });
    await execute(interaction);
    expect(addMemoryMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/no text/i);
  });

  it("refuses a message over 200 chars", async () => {
    const { interaction } = ctxInteraction({ content: "x".repeat(201) });
    await execute(interaction);
    expect(addMemoryMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/too long to remember/i);
  });

  it("refuses outside a guild (no guildId)", async () => {
    const { interaction } = ctxInteraction({ guildId: null });
    interaction.guildId = null;
    await execute(interaction);
    expect(addMemoryMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/only remember messages in servers/i);
  });

  it("saves a fact about another user with attributed phrasing", async () => {
    const { interaction, targetAuthor } = ctxInteraction({ content: "I love TypeScript" });
    await execute(interaction);
    expect(addMemoryMock).toHaveBeenCalledTimes(1);
    const [gid, targetId, fact, addedBy] = addMemoryMock.mock.calls[0];
    expect(gid).toBe("g1");
    expect(targetId).toBe(targetAuthor.id);
    expect(fact).toBe(`speaker said: "I love TypeScript"`);
    expect(addedBy).toBe(interaction.user.id);
    expect(repliedText(interaction)).toMatch(/remembered what speaker said/i);
  });

  it("uses self-phrasing when remembering your own message", async () => {
    const self = makeUser({ username: "invoker", id: "invoker-id" });
    const interaction = makeInteraction({ user: self, options: {} });
    interaction.guildId = "g1";
    interaction.targetMessage = makeMessage({ content: "my own note", author: self });
    await execute(interaction);
    const [, targetId, fact] = addMemoryMock.mock.calls[0];
    expect(targetId).toBe(self.id);
    expect(fact).toBe(`said: "my own note"`);
    expect(repliedText(interaction)).toMatch(/remembered what you said/i);
  });

  it("skips near-duplicate facts", async () => {
    memState.existing = [{ fact: `speaker said: "I love TypeScript"` }];
    const { interaction } = ctxInteraction({ content: "I love TypeScript" });
    await execute(interaction);
    expect(addMemoryMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/already remember/i);
  });

  it("reports an error when addMemory throws", async () => {
    memState.addThrows = true;
    const { interaction } = ctxInteraction({ content: "store me" });
    await execute(interaction);
    expect(addMemoryMock).toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/couldn't save that memory/i);
    expect(repliedText(interaction)).toContain("db locked");
  });
});
