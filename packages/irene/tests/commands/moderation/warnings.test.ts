// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../database.js", () => ({
  getWarnings: vi.fn(() => []),
  deleteWarning: vi.fn(),
  clearWarnings: vi.fn(() => ({ changes: 0 })),
  getTrustedUsers: vi.fn(() => []),
}));

import * as warnings from "../../../commands/moderation/warnings.js";
import { getWarnings, clearWarnings } from "../../../database.js";
import {
  makeInteraction, makeGuild, makeUser, makeMember,
  makePermissions, repliedText,
} from "../../_helpers/mockDiscord.js";

function setup({ action, target, invokerOwner = true } = {}) {
  const guild = makeGuild({});
  const invoker = makeUser({ tag: "mod#0001" });
  if (invokerOwner) guild.ownerId = invoker.id;
  const member = makeMember({ user: invoker, guild, permissions: invokerOwner ? "all" : [] });
  const tUser = target ?? makeUser({ tag: "checked#0001" });
  const interaction = makeInteraction({
    guild, user: invoker, member,
    options: { user: tUser, ...(action ? { action } : {}) },
  });
  return { interaction, tUser };
}

beforeEach(() => vi.clearAllMocks());

describe("warnings command", () => {
  it("declares warnings metadata", () => {
    expect(warnings.data.name).toBe("warnings");
  });

  it("refuses a non-admin invoker", async () => {
    const { interaction } = setup({ invokerOwner: false });
    interaction.member.permissions = makePermissions([]);
    await warnings.execute(interaction);
    expect(repliedText(interaction)).toMatch(/restricted to .*admins/i);
    expect(getWarnings).not.toHaveBeenCalled();
  });

  it("clears warnings and reports the change count on action=clear", async () => {
    clearWarnings.mockReturnValueOnce({ changes: 3 });
    const { interaction, tUser } = setup({ action: "clear" });
    await warnings.execute(interaction);
    expect(clearWarnings).toHaveBeenCalledWith(interaction.guild.id, tUser.id);
    expect(repliedText(interaction)).toMatch(/Cleared/i);
    expect(repliedText(interaction)).toContain("3");
  });

  it("reports No Warnings when the user is clean (default view action)", async () => {
    getWarnings.mockReturnValueOnce([]);
    const { interaction } = setup({});
    await warnings.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No Warnings/i);
  });

  it("lists warnings with their reasons when present", async () => {
    getWarnings.mockReturnValueOnce([
      { reason: "spam", created_at: new Date().toISOString(), moderator_id: "999" },
      { reason: "flame", created_at: new Date().toISOString(), moderator_id: "999" },
    ]);
    const { interaction } = setup({ action: "view" });
    await warnings.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("spam");
    expect(text).toContain("flame");
    expect(text).toMatch(/Total/i);
  });
});
