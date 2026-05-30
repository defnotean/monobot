// ─── directiveExecutor — content validation + channel scoping + list/remove ──
//
// directiveAuth.test.ts pins the admin SECURITY gate through executeTool. This
// spec exercises the post-gate logic of the handler directly: empty/too-long
// directive rejection, channel-scoped vs server-wide saves, the DB
// success:false passthrough, the numeric-vs-keyword remove resolution, and the
// list formatting. All callers here are admins (the gate is covered elsewhere).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";

const dbMock = vi.hoisted(() => ({
  addDirective: vi.fn(() => ({ success: true, index: 0 })),
  removeDirective: vi.fn(() => ({ success: true, removed: "old rule" })),
  getDirectives: vi.fn(() => []),
  getTrustedUsers: vi.fn(() => [] as string[]),
}));

vi.mock("../../../database.js", () => dbMock);

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/directiveExecutor.js";

const guild = { id: "guild-1", ownerId: "owner" };

// An admin member so we're past the auth gate (covered by directiveAuth.test.ts).
function adminMessage() {
  return {
    author: { id: "admin-1" },
    member: {
      id: "admin-1",
      guild,
      permissions: { has: (p: bigint) => p === PermissionFlagsBits.Administrator },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getTrustedUsers.mockReturnValue([]);
});

describe("directiveExecutor — routing", () => {
  it("returns undefined for an unhandled tool", async () => {
    const r = await execute("not_directive", {}, adminMessage(), { guild });
    expect(r).toBeUndefined();
  });
});

describe("save_directive (admin)", () => {
  it("rejects an empty directive", async () => {
    const r = await execute("save_directive", { directive: "   " }, adminMessage(), { guild, findChannel: vi.fn() });
    expect(String(r)).toMatch(/what should i remember/i);
    expect(dbMock.addDirective).not.toHaveBeenCalled();
  });

  it("rejects a directive over 500 chars", async () => {
    const r = await execute("save_directive", { directive: "x".repeat(501) }, adminMessage(), { guild, findChannel: vi.fn() });
    expect(String(r)).toMatch(/too long/i);
    expect(dbMock.addDirective).not.toHaveBeenCalled();
  });

  it("saves a server-wide directive when no channel is given", async () => {
    dbMock.addDirective.mockReturnValue({ success: true, index: 2 });
    const findChannel = vi.fn();
    const r = await execute("save_directive", { directive: "be concise" }, adminMessage(), { guild, findChannel });
    expect(dbMock.addDirective).toHaveBeenCalledWith("guild-1", "be concise", null, "admin-1");
    expect(findChannel).not.toHaveBeenCalled();
    expect(String(r)).toMatch(/saved directive #3.*server-wide/i);
  });

  it("scopes a directive to a resolved channel", async () => {
    dbMock.addDirective.mockReturnValue({ success: true, index: 0 });
    const findChannel = vi.fn(() => ({ id: "chan-9" }));
    const r = await execute(
      "save_directive",
      { directive: "no swearing", channel_name: "general" },
      adminMessage(),
      { guild, findChannel },
    );
    expect(dbMock.addDirective).toHaveBeenCalledWith("guild-1", "no swearing", "chan-9", "admin-1");
    expect(String(r)).toContain("<#chan-9>");
  });

  it("falls back to server-wide when the named channel can't be resolved", async () => {
    dbMock.addDirective.mockReturnValue({ success: true, index: 0 });
    const findChannel = vi.fn(() => null);
    const r = await execute(
      "save_directive",
      { directive: "rule", channel_name: "ghost-channel" },
      adminMessage(),
      { guild, findChannel },
    );
    expect(dbMock.addDirective).toHaveBeenCalledWith("guild-1", "rule", null, "admin-1");
    expect(String(r)).toMatch(/server-wide/i);
  });

  it("surfaces the DB's reason when the save fails (e.g. cap reached)", async () => {
    dbMock.addDirective.mockReturnValue({ success: false, reason: "too many directives (max 20)" });
    const r = await execute("save_directive", { directive: "one more" }, adminMessage(), { guild, findChannel: vi.fn() });
    expect(String(r)).toMatch(/too many directives/i);
  });
});

describe("list_directives (read-only)", () => {
  it("reports the empty state", async () => {
    dbMock.getDirectives.mockReturnValue([]);
    const r = await execute("list_directives", {}, adminMessage(), { guild });
    expect(String(r)).toMatch(/no directives saved/i);
  });

  it("numbers each directive and annotates channel scoping", async () => {
    dbMock.getDirectives.mockReturnValue([
      { text: "be nice", channel: null },
      { text: "no spam", channel: "chan-9" },
    ]);
    const r = await execute("list_directives", {}, adminMessage(), { guild });
    expect(String(r)).toContain("1. be nice");
    expect(String(r)).toContain("2. no spam (channel: <#chan-9>)");
  });
});

describe("remove_directive (admin)", () => {
  it("requires a number or keyword", async () => {
    const r = await execute("remove_directive", { keyword: "  " }, adminMessage(), { guild });
    expect(String(r)).toMatch(/give me a directive number or keyword/i);
    expect(dbMock.removeDirective).not.toHaveBeenCalled();
  });

  it("converts a numeric keyword to a zero-based index", async () => {
    dbMock.removeDirective.mockReturnValue({ success: true, removed: "be nice" });
    const r = await execute("remove_directive", { keyword: "3" }, adminMessage(), { guild });
    expect(dbMock.removeDirective).toHaveBeenCalledWith("guild-1", 2);
    expect(String(r)).toMatch(/removed directive: "be nice"/);
  });

  it("passes a non-numeric keyword through as-is", async () => {
    dbMock.removeDirective.mockReturnValue({ success: true, removed: "no spam" });
    await execute("remove_directive", { keyword: "spam" }, adminMessage(), { guild });
    expect(dbMock.removeDirective).toHaveBeenCalledWith("guild-1", "spam");
  });

  it("surfaces the DB's reason when removal fails (not found)", async () => {
    dbMock.removeDirective.mockReturnValue({ success: false, reason: "no directive matching that" });
    const r = await execute("remove_directive", { keyword: "99" }, adminMessage(), { guild });
    expect(String(r)).toMatch(/no directive matching/i);
  });
});
