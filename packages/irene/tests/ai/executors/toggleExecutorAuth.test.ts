import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error - importing JS module without types
import { execute as executeToggle } from "../../../ai/executors/toggleExecutor.js";

vi.mock("../../../database.js", () => ({
  setFeatureToggle: vi.fn(),
  addTrustedUser: vi.fn(),
  removeTrustedUser: vi.fn(),
  getTrustedUsers: vi.fn(() => []),
  addAutoResponder: vi.fn(() => true),
  getAutoResponders: vi.fn(() => []),
  removeAutoResponder: vi.fn(() => true),
  setInviteFilter: vi.fn(),
}));

import {
  setFeatureToggle,
  addTrustedUser,
  removeTrustedUser,
  getTrustedUsers,
  setInviteFilter,
} from "../../../database.js";

function buildGuild() {
  return {
    id: "guild-1",
    ownerId: "owner-id",
    name: "Test Guild",
    memberCount: 42,
    members: { cache: new Map() },
  };
}

function buildMember({ id = "caller-id", admin = false, manageGuild = false } = {}) {
  const guild = buildGuild();
  const member = {
    id,
    guild,
    permissions: {
      has: (perm: bigint) => (
        (perm === PermissionFlagsBits.Administrator && admin)
        || (perm === PermissionFlagsBits.ManageGuild && manageGuild)
      ),
    },
  };
  return { guild, member };
}

function buildMessage(member: any, guild: any) {
  return {
    member,
    guild,
    author: { id: member.id, username: "caller" },
  };
}

function buildCtx(guild: any) {
  return {
    guild,
    findMember: vi.fn(() => ({ id: "target-id", user: { username: "target" } })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTrustedUsers).mockReturnValue([]);
});

describe("toggleExecutor admin mutators", () => {
  it("blocks a non-admin direct trust_user call before mutating trusted users", async () => {
    const { guild, member } = buildMember();
    const ctx = buildCtx(guild);

    const result = await executeToggle(
      "trust_user",
      { username: "target" },
      buildMessage(member, guild),
      ctx,
    );

    expect(String(result)).toMatch(/permission denied|only admins/i);
    expect(ctx.findMember).not.toHaveBeenCalled();
    expect(addTrustedUser).not.toHaveBeenCalled();
  });

  it("allows an admin direct trust_user call", async () => {
    const { guild, member } = buildMember({ admin: true });
    const ctx = buildCtx(guild);

    const result = await executeToggle(
      "trust_user",
      { username: "target" },
      buildMessage(member, guild),
      ctx,
    );

    expect(result).toBe("done");
    expect(addTrustedUser).toHaveBeenCalledWith("guild-1", "target-id");
  });

  it("does not let ManageGuild callers grant trusted-user bypass", async () => {
    const { guild, member } = buildMember({ manageGuild: true });
    const ctx = buildCtx(guild);

    const result = await executeToggle(
      "trust_user",
      { username: "target" },
      buildMessage(member, guild),
      ctx,
    );

    expect(String(result)).toMatch(/administrator/i);
    expect(ctx.findMember).not.toHaveBeenCalled();
    expect(addTrustedUser).not.toHaveBeenCalled();
  });

  it("blocks non-admin server-level toggles before mutating guild settings", async () => {
    const { guild, member } = buildMember();
    const msg = buildMessage(member, guild);

    await expect(executeToggle("toggle_twin_chat", { enabled: true }, msg, buildCtx(guild)))
      .resolves.toMatch(/permission denied|only admins/i);
    await expect(executeToggle("toggle_voice_tracking", { enabled: true }, msg, buildCtx(guild)))
      .resolves.toMatch(/permission denied|only admins/i);
    await expect(executeToggle("toggle_invite_filter", { enabled: true }, msg, buildCtx(guild)))
      .resolves.toMatch(/permission denied|only admins/i);

    expect(setFeatureToggle).not.toHaveBeenCalled();
    expect(setInviteFilter).not.toHaveBeenCalled();
  });

  it("blocks a non-admin direct untrust_user call before mutating trusted users", async () => {
    const { guild, member } = buildMember();
    const ctx = buildCtx(guild);

    const result = await executeToggle(
      "untrust_user",
      { username: "target" },
      buildMessage(member, guild),
      ctx,
    );

    expect(String(result)).toMatch(/permission denied|only admins/i);
    expect(ctx.findMember).not.toHaveBeenCalled();
    expect(removeTrustedUser).not.toHaveBeenCalled();
  });
});
