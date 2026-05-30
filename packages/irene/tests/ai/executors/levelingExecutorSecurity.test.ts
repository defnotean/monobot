import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

vi.mock("../../../utils/leveling.js", () => ({
  setLevelReward: vi.fn(),
  removeLevelReward: vi.fn(),
  setLevelSettings: vi.fn(),
  getLevelSettings: vi.fn(() => ({})),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/levelingExecutor.js";
import { setLevelReward } from "../../../utils/leveling.js";
import { makeGuild, makeMember, makePermissions, makeRole, makeUser } from "../../_helpers/mockDiscord.js";

function buildHarness() {
  const role = makeRole({
    id: "danger-role",
    name: "Adminish",
    position: 2,
    permissions: makePermissions([PermissionFlagsBits.ManageRoles]),
  });
  const guild = makeGuild({
    roles: [role],
    botPermissions: [PermissionFlagsBits.ManageRoles],
    botHighestRolePosition: 100,
  });
  const actor = makeMember({
    user: makeUser({ id: "actor", username: "actor", tag: "actor#0001" }),
    guild,
    permissions: [PermissionFlagsBits.ManageGuild],
    highestRolePosition: 50,
  });
  guild.members.cache.set(actor.id, actor);
  const message = { guild, member: actor, author: actor.user };
  const ctx = {
    guild,
    findChannel: vi.fn(),
    findRole: vi.fn((g: any, name: string) => g.roles.cache.find((r: any) => r.name.toLowerCase() === name.toLowerCase()) ?? null),
    findRoles: vi.fn(),
  };
  return { guild, message, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("levelingExecutor reward safety", () => {
  it("rejects dangerous roles as automatic level rewards", async () => {
    const { message, ctx } = buildHarness();

    const result = await execute("set_level_reward", { level: 5, role_name: "Adminish" }, message, ctx);

    expect(result).toMatch(/elevated permissions/i);
    expect(setLevelReward).not.toHaveBeenCalled();
  });
});
