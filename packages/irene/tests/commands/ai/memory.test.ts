// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const { memState, paginateMock } = vi.hoisted(() => ({
  memState: {
    list: [],
    remove: { success: true },
    clear: { success: true },
    search: [],
  },
  paginateMock: vi.fn(async () => {}),
}));

vi.mock("../../../ai/memory.js", () => ({
  addMemory: vi.fn(),
  getMemories: vi.fn(() => memState.list),
  removeMemory: vi.fn(() => memState.remove),
  clearMemories: vi.fn(() => memState.clear),
  searchMemories: vi.fn(() => memState.search),
}));

vi.mock("../../../utils/pagination.js", () => ({ paginate: paginateMock }));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  getMemories,
  removeMemory,
  clearMemories,
  searchMemories,
} from "../../../ai/memory.js";
import { execute, data } from "../../../commands/ai/memory.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeUser,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

// memory.js reads interaction.memberPermissions.has(Administrator) directly.
function adminPerms(isAdmin) {
  return { has: (flag) => (isAdmin ? flag === PermissionFlagsBits.Administrator : false) };
}

beforeEach(() => {
  vi.clearAllMocks();
  memState.list = [];
  memState.remove = { success: true };
  memState.clear = { success: true };
  memState.search = [];
});

describe("/memory", () => {
  it("declares the memory command", () => {
    expect(data.name).toBe("memory");
  });

  it("list: shows 'no memories' when empty", async () => {
    memState.list = [];
    const interaction = makeInteraction({ subcommand: "list", options: {} });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(getMemories).toHaveBeenCalledWith(interaction.guild.id, interaction.user.id);
    expect(repliedText(interaction)).toMatch(/no memories/i);
  });

  it("list: renders a small list inline (no pagination)", async () => {
    memState.list = [{ fact: "likes coffee" }, { fact: "from Spain" }];
    const interaction = makeInteraction({ subcommand: "list", options: {} });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(paginateMock).not.toHaveBeenCalled();
    const text = repliedText(interaction);
    expect(text).toContain("likes coffee");
    expect(text).toContain("from Spain");
  });

  it("list: paginates when there are more than 10 memories", async () => {
    memState.list = Array.from({ length: 12 }, (_, i) => ({ fact: `f${i}` }));
    const interaction = makeInteraction({ subcommand: "list", options: {} });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(paginateMock).toHaveBeenCalledTimes(1);
  });

  it("blocks viewing another user's memories for non-admins", async () => {
    const other = makeUser({ username: "victim" });
    const interaction = makeInteraction({
      subcommand: "list",
      options: { user: other },
    });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(getMemories).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/not authorized/i);
  });

  it("admins may target another user", async () => {
    const other = makeUser({ username: "alice" });
    memState.list = [{ fact: "x" }];
    const interaction = makeInteraction({
      subcommand: "list",
      options: { user: other },
    });
    interaction.memberPermissions = adminPerms(true);
    await execute(interaction);
    expect(getMemories).toHaveBeenCalledWith(interaction.guild.id, other.id);
  });

  it("forget: removes a memory by 1-based index", async () => {
    memState.remove = { success: true };
    const interaction = makeInteraction({
      subcommand: "forget",
      options: { index: 2 },
    });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    // index passed to removeMemory is 0-based (2 - 1).
    expect(removeMemory).toHaveBeenCalledWith(interaction.guild.id, interaction.user.id, 1);
    expect(repliedText(interaction)).toMatch(/removed memory #2/i);
  });

  it("forget: surfaces a failure message", async () => {
    memState.remove = { success: false, message: "out of range" };
    const interaction = makeInteraction({
      subcommand: "forget",
      options: { index: 99 },
    });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/couldn't remove/i);
    expect(repliedText(interaction)).toContain("out of range");
  });

  it("clear: wipes all memories on success", async () => {
    const interaction = makeInteraction({ subcommand: "clear", options: {} });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(clearMemories).toHaveBeenCalledWith(interaction.guild.id, interaction.user.id);
    expect(repliedText(interaction)).toMatch(/cleared/i);
  });

  it("search: reports no results", async () => {
    memState.search = [];
    const interaction = makeInteraction({
      subcommand: "search",
      options: { query: "pizza" },
    });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(searchMemories).toHaveBeenCalledWith(interaction.guild.id, "pizza");
    expect(repliedText(interaction)).toMatch(/no results/i);
  });

  it("search: lists matching results", async () => {
    memState.search = [{ userId: "u9", memory: { fact: "loves pizza" } }];
    const interaction = makeInteraction({
      subcommand: "search",
      options: { query: "pizza" },
    });
    interaction.memberPermissions = adminPerms(false);
    await execute(interaction);
    expect(repliedText(interaction)).toContain("loves pizza");
    expect(repliedText(interaction)).toContain("<@u9>");
  });
});
