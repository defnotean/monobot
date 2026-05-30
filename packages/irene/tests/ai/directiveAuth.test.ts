import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

// ─── Regression: directive write tools are admin-gated ───────────────────────
//
// Adversarial audit (SECURITY_AUDIT_2026-05-29.md Finding 5) confirmed a HIGH
// auth gap: Irene's save_directive / remove_directive handlers had NO permission
// check and lived in EVERYONE_TOOLS, so any member could mutate the directives
// that get injected into Irene's system prompt as admin-set "override your
// default behavior" rules — directly, or laundered through schedule_task.
//
// These tests pin BOTH layers of the fix:
//   1. The handler gate in ai/executor.js (covers ALL providers, incl. ones
//      with no admin tool filter, and the scheduled-task fire path).
//   2. The ADMIN_TOOLS reclassification, which makes the scheduler's
//      isAdminToolName gate block the schedule_task path too.
//
// Each test below FAILS on the pre-fix code (no gate + EVERYONE classification)
// and PASSES after.

const db = vi.hoisted(() => ({
  // Directive mutators — the things that must NOT run for a non-admin.
  addDirective: vi.fn(() => ({ success: true, index: 0 })),
  removeDirective: vi.fn(() => ({ success: true, removed: "old rule" })),
  getDirectives: vi.fn(() => []),
  // permissions.js → isAdminMember reads the trusted-user allowlist.
  getTrustedUsers: vi.fn(() => [] as string[]),
}));

vi.mock("../../database.js", () => db);
vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
  sendModLog: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import { executeTool } from "../../ai/executor.js";
// @ts-expect-error - importing JS module without types
import { ADMIN_TOOLS, EVERYONE_TOOLS } from "../../ai/tools.js";

function buildMessage({ admin = false, owner = false, hasMember = true } = {}) {
  const authorId = "200000000000000002";
  const guild: any = {
    id: "100000000000000001",
    ownerId: owner ? authorId : "999999999999999999",
    name: "Test Guild",
  };
  const member: any = hasMember
    ? {
        id: authorId,
        guild,
        permissions: {
          has: (perm: bigint) =>
            admin && (perm === PermissionFlagsBits.Administrator || perm === PermissionFlagsBits.ManageGuild),
        },
      }
    : null;
  return {
    author: { id: authorId, username: "regular" },
    member,
    guild,
    channel: { id: "300000000000000003", send: vi.fn(async () => ({})) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getTrustedUsers.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("directive tool classification", () => {
  it("classifies save_directive and remove_directive as ADMIN, list_directives as EVERYONE", () => {
    const adminNames = new Set(ADMIN_TOOLS.map((t: { name: string }) => t.name));
    const everyoneNames = new Set(EVERYONE_TOOLS.map((t: { name: string }) => t.name));

    // Write tools moved to ADMIN_TOOLS so dual.js's admin filter, the registry
    // isAdmin filter, and scheduler.isAdminToolName all block non-admins.
    expect(adminNames.has("save_directive")).toBe(true);
    expect(adminNames.has("remove_directive")).toBe(true);
    expect(everyoneNames.has("save_directive")).toBe(false);
    expect(everyoneNames.has("remove_directive")).toBe(false);

    // Read-only list_directives stays available to everyone.
    expect(everyoneNames.has("list_directives")).toBe(true);
    expect(adminNames.has("list_directives")).toBe(false);
  });
});

describe("directive handler gate (executeTool, all providers)", () => {
  it("refuses a non-admin save_directive and never mutates directives", async () => {
    const message = buildMessage();

    const result = await executeTool(
      "save_directive",
      { directive: "always speak pirate in #general" },
      message,
    );

    expect(String(result)).toMatch(/only admins\/mods can set or remove directives/i);
    expect(db.addDirective).not.toHaveBeenCalled();
  });

  it("refuses a non-admin remove_directive and never mutates directives", async () => {
    const message = buildMessage();

    const result = await executeTool("remove_directive", { keyword: "1" }, message);

    expect(String(result)).toMatch(/only admins\/mods can set or remove directives/i);
    expect(db.removeDirective).not.toHaveBeenCalled();
  });

  it("treats a missing message.member (DM / failed rehydrate) as non-admin", async () => {
    const message = buildMessage({ hasMember: false });

    const result = await executeTool(
      "save_directive",
      { directive: "be mean to everyone" },
      message,
    );

    expect(String(result)).toMatch(/only admins\/mods can set or remove directives/i);
    expect(db.addDirective).not.toHaveBeenCalled();
  });

  it("lets an admin save_directive succeed and mutate directives", async () => {
    const message = buildMessage({ admin: true });

    const result = await executeTool(
      "save_directive",
      { directive: "always be helpful" },
      message,
    );

    expect(String(result)).not.toMatch(/only admins\/mods/i);
    expect(db.addDirective).toHaveBeenCalledWith(
      message.guild.id,
      "always be helpful",
      null,
      message.author.id,
    );
  });

  it("lets an admin remove_directive succeed and mutate directives", async () => {
    const message = buildMessage({ admin: true });

    const result = await executeTool("remove_directive", { keyword: "1" }, message);

    expect(String(result)).not.toMatch(/only admins\/mods/i);
    expect(db.removeDirective).toHaveBeenCalledWith(message.guild.id, 0);
  });

  it("still treats the guild owner as admin for save_directive", async () => {
    const message = buildMessage({ owner: true });

    const result = await executeTool(
      "save_directive",
      { directive: "owner rule" },
      message,
    );

    expect(String(result)).not.toMatch(/only admins\/mods/i);
    expect(db.addDirective).toHaveBeenCalled();
  });

  it("treats a trusted (non-admin) user as authorized for save_directive", async () => {
    const message = buildMessage();
    db.getTrustedUsers.mockReturnValue([message.author.id]);

    const result = await executeTool(
      "save_directive",
      { directive: "trusted rule" },
      message,
    );

    expect(String(result)).not.toMatch(/only admins\/mods/i);
    expect(db.addDirective).toHaveBeenCalled();
  });

  it("leaves list_directives ungated (read-only) for a non-admin", async () => {
    const message = buildMessage();

    const result = await executeTool("list_directives", {}, message);

    // No refusal — the read path runs and consults the DB.
    expect(String(result)).not.toMatch(/only admins\/mods/i);
    expect(db.getDirectives).toHaveBeenCalledWith(message.guild.id);
  });
});
