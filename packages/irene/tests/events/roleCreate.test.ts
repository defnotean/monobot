import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionsBitField } from "discord.js";

// roleCreate logs a "Role Created" mod-log embed enriched with the audit-log
// executor and a permission-derived category. We mock sendModLog (the side
// effect sink) but keep the REAL logEvent + categorizeRole so the produced
// EmbedBuilder has a realistic `.data` shape.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/roleCreate.js";

function perms(arr: string[]) {
  return new PermissionsBitField(
    arr.map((p) => PermissionsBitField.Flags[p as keyof typeof PermissionsBitField.Flags]),
  );
}

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    name: "Test Guild",
    fetchAuditLogs: vi.fn(async () => ({
      entries: { first: () => firstEntry },
    })),
  };
}

function makeRole(overrides: any = {}) {
  return {
    id: "role-1",
    name: "Moderator",
    hexColor: "#ff0000",
    hoist: false,
    mentionable: false,
    position: 3,
    managed: false,
    permissions: perms([]),
    tags: null,
    ...overrides,
    guild: overrides.guild ?? makeGuild(),
  };
}

function embedText() {
  const embed = sendModLog.mock.calls[0][1];
  return JSON.stringify(embed.data);
}

beforeEach(() => {
  sendModLog.mockClear();
});

describe("roleCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("roleCreate");
  });

  it("sends a Role Created embed with role mention, id and color", async () => {
    await execute(makeRole());
    expect(sendModLog).toHaveBeenCalledTimes(1);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.author.name).toContain("Role Created");
    const text = embedText();
    expect(text).toContain("<@&role-1>");
    expect(text).toContain("role-1");
    expect(text).toContain("#ff0000");
  });

  it("uses the ROLE_CREATE audit type (30) and attributes the actor in the description", async () => {
    const guild = makeGuild({
      target: { id: "role-1" },
      executor: { id: "admin-1", tag: "admin#0001" },
      reason: "promotion",
      createdTimestamp: Date.now(),
    });
    await execute(makeRole({ guild }));

    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 30, limit: 1 });
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain("<@admin-1>");
    // reason rendered as its own field
    expect(embedText()).toContain("promotion");
  });

  it("ignores a stale audit entry (older than 5s) — no actor attribution", async () => {
    const guild = makeGuild({
      target: { id: "role-1" },
      executor: { id: "admin-1", tag: "admin#0001" },
      createdTimestamp: Date.now() - 10_000,
    });
    await execute(makeRole({ guild }));
    expect(sendModLog.mock.calls[0][1].data.description).not.toContain("<@admin-1>");
  });

  it("flags dangerous permissions (Administrator) in the meta", async () => {
    await execute(makeRole({ permissions: perms(["Administrator"]) }));
    expect(embedText()).toContain("Administrator");
  });

  it("derives the category from permissions (BanMembers => moderator)", async () => {
    await execute(makeRole({ name: "no-keyword-here", permissions: perms(["BanMembers"]) }));
    expect(embedText()).toContain("moderator");
  });

  it("best-effort: still logs the embed when the audit-log fetch throws", async () => {
    const guild: any = makeGuild();
    guild.fetchAuditLogs = vi.fn(async () => {
      throw new Error("missing ViewAuditLog");
    });
    await execute(makeRole({ guild }));
    expect(sendModLog).toHaveBeenCalledTimes(1);
  });
});
