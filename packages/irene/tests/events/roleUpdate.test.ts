import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionsBitField } from "discord.js";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/roleUpdate.js";

function perms(arr: string[]) {
  return new PermissionsBitField(
    arr.map((p) => PermissionsBitField.Flags[p as keyof typeof PermissionsBitField.Flags]),
  );
}

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    fetchAuditLogs: vi.fn(async () => ({
      entries: { first: () => firstEntry },
    })),
  };
}

function makeRole(overrides: any = {}) {
  return {
    id: "role-1",
    name: "Member",
    hexColor: "#000000",
    hoist: false,
    mentionable: false,
    position: 1,
    permissions: perms([]),
    members: { size: 5 },
    ...overrides,
    guild: overrides.guild ?? makeGuild(),
  };
}

function embedText() {
  return JSON.stringify(sendModLog.mock.calls[0][1].data);
}

beforeEach(() => {
  sendModLog.mockClear();
});

describe("roleUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("roleUpdate");
  });

  it("does NOT log when nothing meaningful changed (no diff)", async () => {
    const guild = makeGuild();
    await execute(makeRole({ guild }), makeRole({ guild }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a name change diff", async () => {
    const guild = makeGuild();
    await execute(
      makeRole({ guild, name: "Member" }),
      makeRole({ guild, name: "Trusted" }),
    );
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(sendModLog.mock.calls[0][1].data.author.name).toContain("Role Updated");
    const text = embedText();
    expect(text).toContain("Member");
    expect(text).toContain("Trusted");
    expect(text).toContain("Name");
  });

  it("diffs granted vs revoked permissions and flags dangerous escalation", async () => {
    const guild = makeGuild();
    await execute(
      makeRole({ guild, permissions: perms(["KickMembers"]) }),
      makeRole({ guild, permissions: perms(["BanMembers"]) }),
    );
    const text = embedText();
    // humanPerm spaces out PascalCase: "Ban Members" / "Kick Members"
    expect(text).toContain("Ban Members");
    expect(text).toContain("Kick Members");
    // BanMembers is dangerous => escalation warning present
    expect(text).toContain("Dangerous permission");
  });

  it("uses ROLE_UPDATE audit type (31) and attributes the actor", async () => {
    const guild = makeGuild({
      target: { id: "role-1" },
      executor: { id: "owner-1", tag: "owner#0001" },
      createdTimestamp: Date.now(),
    });
    await execute(
      makeRole({ guild, hoist: false }),
      makeRole({ guild, hoist: true }),
    );
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 31, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@owner-1>");
  });

  it("logs a position change", async () => {
    const guild = makeGuild();
    await execute(
      makeRole({ guild, position: 1 }),
      makeRole({ guild, position: 9 }),
    );
    expect(embedText()).toContain("Position");
  });
});
