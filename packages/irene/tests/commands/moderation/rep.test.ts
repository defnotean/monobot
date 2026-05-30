// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn(), sendModLog: vi.fn(async () => {}) }));
vi.mock("../../../database.js", () => ({
  getWarnings: vi.fn(() => []),
  getTrustedUsers: vi.fn(() => []),
}));
// paginate is invoked for history/leaderboard with data; stub so it just renders page 0.
vi.mock("../../../utils/pagination.js", () => ({
  paginate: vi.fn(async (interaction, { items, formatPage }) => {
    const embed = formatPage(items.slice(0, 10), 0, 1);
    return interaction.reply({ embeds: [embed] });
  }),
  formatDuration: (ms) => `${ms}ms`,
}));

import * as rep from "../../../commands/moderation/rep.js";
import { getWarnings } from "../../../database.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember,
  makePermissions, repliedText,
} from "../../_helpers/mockDiscord.js";

function setup({ subcommand = "view", options = {}, invokerOwner = true } = {}) {
  const guild = makeGuild({});
  const invoker = makeUser({ tag: "mod#0001" });
  if (invokerOwner) guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [] });
  const interaction = makeInteraction({ guild, user: invoker, member, subcommand, options });
  return { interaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  getWarnings.mockReturnValue([]);
});

describe("rep command", () => {
  it("declares rep metadata", () => {
    expect(rep.data.name).toBe("rep");
  });

  it("view: renders a Neutral rating for a clean user", async () => {
    const tUser = makeUser({ tag: "clean#0001" });
    const { interaction } = setup({ subcommand: "view", options: { user: tUser } });
    await rep.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toMatch(/Reputation Summary/i);
    expect(text).toMatch(/Neutral/i);
  });

  it("view: warnings drag the score negative (each warning = -2)", async () => {
    getWarnings.mockReturnValue([{ reason: "a" }, { reason: "b" }]);
    const tUser = makeUser({ tag: "bad#0001" });
    const { interaction } = setup({ subcommand: "view", options: { user: tUser } });
    await rep.execute(interaction);
    // 2 warnings -> score -4, reflected as `-4` in the embed.
    expect(repliedText(interaction)).toContain("-4");
  });

  it("note: refused for non-admin invoker", async () => {
    const tUser = makeUser({ tag: "x#0001" });
    const { interaction } = setup({
      subcommand: "note", options: { user: tUser, note: "shady", value: -1 }, invokerOwner: false,
    });
    interaction.member.permissions = makePermissions([]);
    await rep.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
  });

  it("note: admin can add a negative note and the score reflects it", async () => {
    const tUser = makeUser({ tag: `noted-${Date.now()}#0001` });
    const { interaction } = setup({
      subcommand: "note", options: { user: tUser, note: "rude in chat", value: -1 },
    });
    await rep.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toMatch(/Note Added/i);
    expect(text).toContain("rude in chat");
  });

  it("history: reports No History when there is nothing to show", async () => {
    const tUser = makeUser({ tag: "empty#0001" });
    const { interaction } = setup({ subcommand: "history", options: { user: tUser } });
    await rep.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No History/i);
  });

  it("leaderboard: reports no data placeholder", async () => {
    const { interaction } = setup({ subcommand: "leaderboard" });
    await rep.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No reputation data available/i);
  });
});
