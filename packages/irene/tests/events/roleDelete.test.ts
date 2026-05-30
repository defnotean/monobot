import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionsBitField } from "discord.js";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// roleDelete also feeds the anti-nuke tracker — mock it so we can assert it is
// (or isn't) invoked depending on who the actor is.
const trackAction = vi.fn(async () => {});
vi.mock("../../utils/antinuke.js", () => ({
  trackAction: (...a: any[]) => trackAction(...a),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/roleDelete.js";

function perms(arr: string[]) {
  return new PermissionsBitField(
    arr.map((p) => PermissionsBitField.Flags[p as keyof typeof PermissionsBitField.Flags]),
  );
}

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    name: "Test Guild",
    client: { user: { id: "bot-1" } },
    fetchAuditLogs: vi.fn(async () => ({
      entries: { first: () => firstEntry },
    })),
  };
}

function makeRole(overrides: any = {}) {
  return {
    id: "role-9",
    name: "Old Role",
    hexColor: "#00ff00",
    position: 2,
    managed: false,
    members: { size: 0 },
    createdTimestamp: Date.now() - 86_400_000,
    permissions: perms([]),
    ...overrides,
    guild: overrides.guild ?? makeGuild(),
  };
}

function embedText() {
  return JSON.stringify(sendModLog.mock.calls[0][1].data);
}

beforeEach(() => {
  sendModLog.mockClear();
  trackAction.mockClear();
});

describe("roleDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("roleDelete");
  });

  it("logs a Role Deleted embed using the role name and id", async () => {
    await execute(makeRole());
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.author.name).toContain("Role Deleted");
    const text = embedText();
    expect(text).toContain("Old Role");
    expect(text).toContain("role-9");
  });

  it("flags how many members were affected", async () => {
    await execute(makeRole({ members: { size: 7 } }));
    expect(embedText()).toContain("7 members");
  });

  it("uses ROLE_DELETE audit type (32) and attributes the deleter + tracks anti-nuke", async () => {
    const guild = makeGuild({
      target: { id: "role-9" },
      executor: { id: "mod-1", tag: "mod#1234" },
      createdTimestamp: Date.now(),
    });
    await execute(makeRole({ guild }));

    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 32, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@mod-1>");
    // Actor is a non-bot human -> anti-nuke tracking fires.
    expect(trackAction).toHaveBeenCalledWith(
      "guild-1",
      "mod-1",
      "role_delete",
      expect.anything(),
    );
  });

  it("does NOT track anti-nuke when the actor is the bot itself", async () => {
    const guild = makeGuild({
      target: { id: "role-9" },
      executor: { id: "bot-1", tag: "irene#0001" },
      createdTimestamp: Date.now(),
    });
    await execute(makeRole({ guild }));
    expect(trackAction).not.toHaveBeenCalled();
  });

  it("does NOT track anti-nuke when no actor was resolved from the audit log", async () => {
    await execute(makeRole()); // empty audit log
    expect(trackAction).not.toHaveBeenCalled();
  });
});
