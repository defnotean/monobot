// ─── customCommandExecutor — create/edit/delete/list custom !commands ────────
//
// Exercises the per-guild custom-command CRUD handler directly (same entry the
// router calls). Covers the branches the AI actually trips: duplicate-create
// rejection, embed-color resolution (named / hex / bare-hex / "none" clear),
// the boolean-vs-falsy edit guard (admin_only:false must store false, not null),
// per-field "none"-clears-embed semantics, and the not-found delete/edit paths.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collection, PermissionFlagsBits } from "discord.js";

vi.mock("../../../database.js", () => ({
  getCustomCommand: vi.fn(),
  setCustomCommand: vi.fn(),
  deleteCustomCommand: vi.fn(),
  listCustomCommands: vi.fn(() => []),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/customCommandExecutor.js";
import {
  getCustomCommand,
  setCustomCommand,
  deleteCustomCommand,
  listCustomCommands,
  // @ts-expect-error - importing JS module without types
} from "../../../database.js";

const guild = { id: "guild-1" };
const message = { author: { id: "author-1" } };
const ctx = { guild } as any;

function permissions(...flags: bigint[]) {
  return { has: (flag: bigint) => flags.includes(flag) };
}

function roleGuild(role: any, { botTop = 100 } = {}) {
  const roles = new Collection<string, any>();
  roles.set(role.id, role);
  return {
    id: "guild-roles",
    ownerId: "owner-1",
    roles: {
      cache: roles,
      everyone: { id: "guild-roles", name: "@everyone", position: 0, permissions: permissions() },
    },
    members: {
      me: {
        permissions: permissions(PermissionFlagsBits.ManageRoles),
        roles: { highest: { position: botTop } },
      },
    },
  };
}

function actor(top = 50) {
  return { id: "author-1", roles: { highest: { position: top } } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("customCommandExecutor — routing", () => {
  it("returns undefined for an unhandled tool (lets the next sub-executor try)", async () => {
    const r = await execute("not_a_custom_command_tool", {}, message, ctx);
    expect(r).toBeUndefined();
    expect(setCustomCommand).not.toHaveBeenCalled();
  });
});

describe("create_custom_command", () => {
  it("refuses to create a trigger that already exists", async () => {
    vi.mocked(getCustomCommand).mockReturnValue({ trigger: "hi" });
    const r = await execute("create_custom_command", { trigger: "hi" }, message, ctx);
    expect(String(r)).toMatch(/already exists/i);
    expect(setCustomCommand).not.toHaveBeenCalled();
  });

  it("resolves a NAMED embed color via COLOR_NAMES", async () => {
    vi.mocked(getCustomCommand).mockReturnValue(undefined);
    await execute(
      "create_custom_command",
      { trigger: "red", description: "d", response: "r", embed_color: "Red" },
      message,
      ctx,
    );
    expect(setCustomCommand).toHaveBeenCalledWith(
      "guild-1",
      "red",
      expect.objectContaining({ embed_color: "#FF0000", created_by: "author-1" }),
    );
  });

  it("prefixes a bare hex (no #) with #", async () => {
    vi.mocked(getCustomCommand).mockReturnValue(undefined);
    await execute(
      "create_custom_command",
      { trigger: "c", response: "r", embed_color: "abcdef" },
      message,
      ctx,
    );
    expect(setCustomCommand).toHaveBeenCalledWith(
      "guild-1",
      "c",
      expect.objectContaining({ embed_color: "#abcdef" }),
    );
  });

  it("keeps a #-prefixed hex unchanged", async () => {
    vi.mocked(getCustomCommand).mockReturnValue(undefined);
    await execute(
      "create_custom_command",
      { trigger: "c", response: "r", embed_color: "#123456" },
      message,
      ctx,
    );
    expect(setCustomCommand).toHaveBeenCalledWith(
      "guild-1",
      "c",
      expect.objectContaining({ embed_color: "#123456" }),
    );
  });

  it("treats embed_color 'none' as no color (null)", async () => {
    vi.mocked(getCustomCommand).mockReturnValue(undefined);
    await execute(
      "create_custom_command",
      { trigger: "c", response: "r", embed_color: "none" },
      message,
      ctx,
    );
    expect(setCustomCommand).toHaveBeenCalledWith(
      "guild-1",
      "c",
      expect.objectContaining({ embed_color: null }),
    );
  });

  it("defaults optional fields to null/false and confirms creation", async () => {
    vi.mocked(getCustomCommand).mockReturnValue(undefined);
    const r = await execute(
      "create_custom_command",
      { trigger: "ping", description: "d", response: "pong" },
      message,
      ctx,
    );
    expect(String(r)).toMatch(/Created command !ping/);
    expect(setCustomCommand).toHaveBeenCalledWith(
      "guild-1",
      "ping",
      expect.objectContaining({
        role_to_give: null,
        role_to_remove: null,
        embed_color: null,
        admin_only: false,
        auto_delete: false,
      }),
    );
  });

  it("refuses to save a custom command that would grant a dangerous role", async () => {
    const role = { id: "r-admin", name: "Admin", position: 10, permissions: permissions(PermissionFlagsBits.Administrator) };
    const localGuild = roleGuild(role);
    vi.mocked(getCustomCommand).mockReturnValue(undefined);

    const r = await execute(
      "create_custom_command",
      { trigger: "adminme", response: "no", role_to_give: "Admin" },
      { author: { id: "author-1" }, member: actor() },
      { guild: localGuild, findRole: () => role } as any,
    );

    expect(String(r)).toMatch(/elevated permissions/i);
    expect(setCustomCommand).not.toHaveBeenCalled();
  });

  it("refuses to save a custom command for a role above the bot", async () => {
    const role = { id: "r-high", name: "High", position: 100, permissions: permissions() };
    const localGuild = roleGuild(role, { botTop: 50 });
    vi.mocked(getCustomCommand).mockReturnValue(undefined);

    const r = await execute(
      "create_custom_command",
      { trigger: "high", response: "no", role_to_give: "High" },
      { author: { id: "author-1" }, member: actor(200) },
      { guild: localGuild, findRole: () => role } as any,
    );

    expect(String(r)).toMatch(/above my top role/i);
    expect(setCustomCommand).not.toHaveBeenCalled();
  });
});

describe("edit_custom_command", () => {
  it("rejects editing a command that doesn't exist", async () => {
    vi.mocked(getCustomCommand).mockReturnValue(undefined);
    const r = await execute("edit_custom_command", { trigger: "ghost" }, message, ctx);
    expect(String(r)).toMatch(/doesn't exist/i);
    expect(setCustomCommand).not.toHaveBeenCalled();
  });

  it("stores admin_only:false as false, NOT null (boolean guard)", async () => {
    // Regression: `false || null` would wrongly persist null. The handler
    // special-cases the two boolean fields so an explicit false survives.
    vi.mocked(getCustomCommand).mockReturnValue({
      trigger: "t", response: "r", admin_only: true, auto_delete: true,
    });
    await execute(
      "edit_custom_command",
      { trigger: "t", admin_only: false, auto_delete: false },
      message,
      ctx,
    );
    const stored = vi.mocked(setCustomCommand).mock.calls[0][2];
    expect(stored.admin_only).toBe(false);
    expect(stored.auto_delete).toBe(false);
  });

  it("clears an embed field when the new value is the literal 'none'", async () => {
    vi.mocked(getCustomCommand).mockReturnValue({ trigger: "t", embed_title: "Old Title" });
    await execute(
      "edit_custom_command",
      { trigger: "t", embed_title: "none" },
      message,
      ctx,
    );
    const stored = vi.mocked(setCustomCommand).mock.calls[0][2];
    expect(stored.embed_title).toBeNull();
  });

  it("re-resolves a named embed_color on edit", async () => {
    vi.mocked(getCustomCommand).mockReturnValue({ trigger: "t", embed_color: "#000000" });
    await execute(
      "edit_custom_command",
      { trigger: "t", embed_color: "blue" },
      message,
      ctx,
    );
    const stored = vi.mocked(setCustomCommand).mock.calls[0][2];
    expect(stored.embed_color).toBe("#5865F2");
  });

  it("clears embed_color when edited to 'none'", async () => {
    vi.mocked(getCustomCommand).mockReturnValue({ trigger: "t", embed_color: "#FF0000" });
    await execute("edit_custom_command", { trigger: "t", embed_color: "none" }, message, ctx);
    const stored = vi.mocked(setCustomCommand).mock.calls[0][2];
    expect(stored.embed_color).toBeNull();
  });

  it("maps cmd_description onto the stored description field", async () => {
    vi.mocked(getCustomCommand).mockReturnValue({ trigger: "t", description: "old" });
    await execute(
      "edit_custom_command",
      { trigger: "t", cmd_description: "new desc" },
      message,
      ctx,
    );
    const stored = vi.mocked(setCustomCommand).mock.calls[0][2];
    expect(stored.description).toBe("new desc");
  });

  it("refuses edits that would leave a dangerous role action stored", async () => {
    const role = { id: "r-mod", name: "Mods", position: 10, permissions: permissions(PermissionFlagsBits.BanMembers) };
    const localGuild = roleGuild(role);
    vi.mocked(getCustomCommand).mockReturnValue({ trigger: "modme", response: "old" });

    const r = await execute(
      "edit_custom_command",
      { trigger: "modme", role_to_remove: "Mods" },
      { author: { id: "author-1" }, member: actor() },
      { guild: localGuild, findRole: () => role } as any,
    );

    expect(String(r)).toMatch(/elevated permissions/i);
    expect(setCustomCommand).not.toHaveBeenCalled();
  });
});

describe("delete_custom_command", () => {
  it("confirms deletion when the command existed", async () => {
    vi.mocked(deleteCustomCommand).mockReturnValue(true);
    const r = await execute("delete_custom_command", { trigger: "gone" }, message, ctx);
    expect(String(r)).toMatch(/Deleted !gone/);
  });

  it("reports not-found when the command did not exist", async () => {
    vi.mocked(deleteCustomCommand).mockReturnValue(false);
    const r = await execute("delete_custom_command", { trigger: "nope" }, message, ctx);
    expect(String(r)).toMatch(/doesn't exist/i);
  });
});

describe("list_custom_commands", () => {
  it("returns the empty-state message when there are none", async () => {
    vi.mocked(listCustomCommands).mockReturnValue([]);
    const r = await execute("list_custom_commands", {}, message, ctx);
    expect(String(r)).toMatch(/No custom commands yet/i);
  });

  it("formats each command and flags admin-only ones", async () => {
    vi.mocked(listCustomCommands).mockReturnValue([
      { trigger: "ping", description: "pong it", admin_only: false },
      { trigger: "secret", description: "staff", admin_only: true },
    ]);
    const r = await execute("list_custom_commands", {}, message, ctx);
    expect(String(r)).toContain("!ping — pong it");
    expect(String(r)).toContain("!secret — staff (admin only)");
  });
});
