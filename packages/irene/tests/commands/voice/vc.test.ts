// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// The real tempChannels Map is shared with the command; mock the module so the
// command and the test see the same instance. vi.hoisted keeps the references
// available before the hoisted vi.mock factories run.
const { tempChannels, execState, executeToolMock } = vi.hoisted(() => {
  const execState = { impl: null };
  return {
    tempChannels: new Map(),
    execState,
    executeToolMock: vi.fn((...args) => execState.impl(...args)),
  };
});

vi.mock("../../../utils/tempvc.js", () => ({ tempChannels }));
vi.mock("../../../ai/executor.js", () => ({ executeTool: executeToolMock }));

import { execute, data } from "../../../commands/voice/vc.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeChannel,
  makeMember,
  makeUser,
  makeGuild,
  repliedText,
  lastReply,
  PermissionFlagsBits,
} from "../../_helpers/mockDiscord.js";

// Build an interaction whose member is in a (configurable) voice channel.
function vcInteraction({
  inVoice = true,
  isTemp = true,
  ownerId = "owner-id",
  memberId = "owner-id",
  admin = false,
  subcommand = "private",
  options = {},
} = {}) {
  const user = makeUser({ id: memberId, username: "vcuser" });
  const guild = makeGuild();
  const member = makeMember({
    user,
    guild,
    permissions: admin ? [PermissionFlagsBits.Administrator] : [],
  });
  const vc = makeChannel({ name: "Temp VC", type: 2 });
  member.voice = { channel: inVoice ? vc : null };

  tempChannels.clear();
  if (isTemp) tempChannels.set(vc.id, ownerId);

  const interaction = makeInteraction({
    guild,
    user,
    member,
    subcommand,
    options,
  });
  return { interaction, vc, member, user };
}

beforeEach(() => {
  vi.clearAllMocks();
  tempChannels.clear();
  execState.impl = vi.fn(async () => "Operation succeeded");
});

describe("/vc", () => {
  it("declares the vc command", () => {
    expect(data.name).toBe("vc");
  });

  it("errors when the member isn't in any voice channel", async () => {
    const { interaction } = vcInteraction({ inVoice: false });
    await execute(interaction);
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Not in Voice/i);
  });

  it("errors when the VC is not a temp VC", async () => {
    const { interaction } = vcInteraction({ isTemp: false });
    await execute(interaction);
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/Not a Temp VC/i);
  });

  it("refuses a non-owner, non-admin member", async () => {
    const { interaction } = vcInteraction({
      ownerId: "someone-else",
      memberId: "not-owner",
      admin: false,
    });
    await execute(interaction);
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/You don't own this VC/i);
  });

  it("allows an admin who is not the owner", async () => {
    const { interaction } = vcInteraction({
      ownerId: "someone-else",
      memberId: "admin-user",
      admin: true,
      subcommand: "public",
    });
    await execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledWith("vc_public", {}, expect.any(Object));
    expect(repliedText(interaction)).toMatch(/Set to Public/i);
  });

  it("private: dispatches vc_private with a message proxy", async () => {
    const { interaction } = vcInteraction({ subcommand: "private" });
    await execute(interaction);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const [toolName, toolInput, proxy] = executeToolMock.mock.calls[0];
    expect(toolName).toBe("vc_private");
    expect(toolInput).toEqual({});
    // The proxy carries guild/author/member/channel/client.
    expect(proxy.guild).toBe(interaction.guild);
    expect(proxy.author).toBe(interaction.user);
    expect(repliedText(interaction)).toMatch(/Set to Private/i);
  });

  it("lock: passes the integer limit option through", async () => {
    const { interaction } = vcInteraction({ subcommand: "lock", options: { limit: 5 } });
    await execute(interaction);
    expect(executeToolMock).toHaveBeenCalledWith("vc_lock", { limit: 5 }, expect.any(Object));
    expect(repliedText(interaction)).toMatch(/Locked/i);
  });

  it("rename: forwards the new name", async () => {
    const { interaction } = vcInteraction({ subcommand: "rename", options: { name: "Gamers" } });
    await execute(interaction);
    expect(executeToolMock).toHaveBeenCalledWith("vc_rename", { name: "Gamers" }, expect.any(Object));
    expect(repliedText(interaction)).toMatch(/Renamed/i);
  });

  it("kick: maps the target user id and ban flag", async () => {
    const target = makeUser({ id: "target-id", username: "kicked" });
    const { interaction } = vcInteraction({
      subcommand: "kick",
      options: { user: target, ban: true },
    });
    await execute(interaction);
    expect(executeToolMock).toHaveBeenCalledWith(
      "vc_kick",
      { username: "target-id", ban: true },
      expect.any(Object),
    );
    expect(repliedText(interaction)).toMatch(/Kicked from VC/i);
  });

  it("transfer: maps the new owner id", async () => {
    const target = makeUser({ id: "new-owner", username: "newowner" });
    const { interaction } = vcInteraction({
      subcommand: "transfer",
      options: { user: target },
    });
    await execute(interaction);
    expect(executeToolMock).toHaveBeenCalledWith(
      "vc_transfer",
      { username: "new-owner" },
      expect.any(Object),
    );
    expect(repliedText(interaction)).toMatch(/Ownership Transferred/i);
  });

  it("surfaces an error embed when executeTool throws", async () => {
    execState.impl = vi.fn(async () => {
      throw new Error("tool failure");
    });
    const { interaction } = vcInteraction({ subcommand: "private" });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/Error/i);
    expect(repliedText(interaction)).toContain("tool failure");
  });
});
