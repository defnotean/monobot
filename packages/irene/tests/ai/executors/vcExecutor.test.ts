// ─── vcExecutor — temp-VC ownership gates + admin VC config tools ────────────
//
// Two surfaces here:
//   1. User temp-VC controls (lock/rename/transfer/kick/claim/...) which gate on
//      "are you in a VC", "is this a temp VC", and "do you own it OR are admin".
//   2. Admin-side create-VC config (set_afk_channel, set_vc_default_limit,
//      set_vc_naming_mode, toggle_vc_rich_presence) with their own validation.
//
// We use the REAL tempvc.js maps (module-level Maps, cleared per-test) so the
// ownership logic runs unmocked, and mock the dynamically-imported vcpanel /
// vcrenamer side-effect modules plus the database setters.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, ChannelType } from "discord.js";

const dbMock = vi.hoisted(() => ({
  setAfkSettings: vi.fn(),
  setCreateVcChannel: vi.fn(),
  setVcTemplate: vi.fn(),
  setVcDefaultLimit: vi.fn(),
  saveTempVc: vi.fn(),
  setVcNamingMode: vi.fn(),
  setVcRichPresence: vi.fn(),
}));

vi.mock("../../../database.js", () => dbMock);
vi.mock("../../../utils/vcpanel.js", () => ({ updateControlPanel: vi.fn(async () => {}) }));
vi.mock("../../../utils/vcrenamer.js", () => ({ queueRename: vi.fn() }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/vcExecutor.js";
// @ts-expect-error - importing JS module without types
import { tempChannels, manualRenames, tempTextChannels, tempVcSeq } from "../../../utils/tempvc.js";

// A Map that also exposes the Discord.js Collection methods the handler uses
// (filter→sized collection). Members are iterated as [id, member] pairs.
function memberCollection(entries: Array<[string, any]> = []) {
  const m: any = new Map(entries);
  m.filter = (fn: (v: any) => boolean) => memberCollection([...m.entries()].filter(([, v]) => fn(v)));
  return m;
}

function buildVoiceChannel(id = "vc1", overrides: any = {}) {
  return {
    id,
    name: "Temp VC",
    members: memberCollection(),
    permissionOverwrites: {
      edit: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    setUserLimit: vi.fn(async () => {}),
    setName: vi.fn(async () => {}),
    ...overrides,
  };
}

function buildCaller({ id = "caller", admin = false, voiceCh = null as any } = {}) {
  return {
    id,
    permissions: { has: (p: bigint) => admin && p === PermissionFlagsBits.Administrator },
    voice: { channel: voiceCh },
    user: { tag: "caller#0001", bot: false },
  };
}

function buildGuild(ownerId = "owner") {
  return { id: "guild-1", ownerId, roles: { everyone: { id: "everyone" } } };
}

function expectSafeOwnerOverwrite(overwrite: any) {
  expect(overwrite).toEqual(expect.objectContaining({
    ManageChannels: null,
    MoveMembers: null,
    MuteMembers: null,
    DeafenMembers: null,
    ViewChannel: true,
    Connect: true,
    Speak: true,
    Stream: true,
    UseVAD: true,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  tempChannels.clear();
  manualRenames.clear();
  tempTextChannels.clear();
  tempVcSeq.clear();
});

describe("vcExecutor — routing", () => {
  it("returns undefined for an unhandled tool", async () => {
    const r = await execute("not_vc", {}, { member: buildCaller() }, { guild: buildGuild() });
    expect(r).toBeUndefined();
  });
});

describe("temp-VC ownership gates", () => {
  it("refuses when the caller isn't in a voice channel", async () => {
    const caller = buildCaller({ voiceCh: null });
    const r = await execute("vc_lock", {}, { member: caller }, { guild: buildGuild() });
    expect(String(r)).toMatch(/not in a voice channel/i);
  });

  it("refuses when the channel isn't a temp VC and caller isn't admin", async () => {
    const voiceCh = buildVoiceChannel("vc-plain");
    const caller = buildCaller({ voiceCh });
    // vc-plain is NOT in tempChannels → not a temp VC.
    const r = await execute("vc_lock", {}, { member: caller }, { guild: buildGuild() });
    expect(String(r)).toMatch(/this isn't a temp VC/i);
  });

  it("refuses a non-owner non-admin even when it IS a temp VC", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    tempChannels.set("vc-owned", "someone-else"); // owned by another user
    const caller = buildCaller({ id: "caller", voiceCh });
    const r = await execute("vc_unlock", {}, { member: caller }, { guild: buildGuild() });
    expect(String(r)).toMatch(/don't own this channel/i);
  });

  it("lets the owner lock the VC to the current non-bot member count", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    voiceCh.members = memberCollection([
      ["a", { user: { bot: false } }],
      ["b", { user: { bot: false } }],
      ["bot", { user: { bot: true } }],
    ]);
    tempChannels.set("vc-owned", "caller");
    const caller = buildCaller({ id: "caller", voiceCh });
    const r = await execute("vc_lock", {}, { member: caller }, { guild: buildGuild() });
    expect(voiceCh.setUserLimit).toHaveBeenCalledWith(2);
    expect(String(r)).toMatch(/locked to 2 users/i);
  });

  it("lets an ADMIN act on a non-temp VC (admin override)", async () => {
    const voiceCh = buildVoiceChannel("vc-plain");
    const caller = buildCaller({ id: "admin", admin: true, voiceCh });
    const r = await execute("vc_unlock", {}, { member: caller }, { guild: buildGuild() });
    expect(voiceCh.setUserLimit).toHaveBeenCalledWith(0);
    expect(String(r)).toMatch(/limit removed/i);
  });

  it("vc_rename rejects a too-short name", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    tempChannels.set("vc-owned", "caller");
    const caller = buildCaller({ id: "caller", voiceCh });
    const r = await execute("vc_rename", { name: "x" }, { member: caller }, { guild: buildGuild() });
    expect(String(r)).toMatch(/between 2 and 100 characters/i);
    expect(voiceCh.setName).not.toHaveBeenCalled();
  });

  it("vc_rename applies a valid name and locks the auto-renamer", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    tempChannels.set("vc-owned", "caller");
    const caller = buildCaller({ id: "caller", voiceCh });
    const r = await execute("vc_rename", { name: "  Squad Lounge  " }, { member: caller }, { guild: buildGuild() });
    expect(voiceCh.setName).toHaveBeenCalledWith("Squad Lounge");
    expect(manualRenames.has("vc-owned")).toBe(true);
    expect(String(r)).toMatch(/renamed to \*\*Squad Lounge\*\*/);
  });

  it("vc_claim refuses when the original owner is still present", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    voiceCh.members = memberCollection([["owner-x", { user: { bot: false } }]]);
    tempChannels.set("vc-owned", "owner-x");
    const caller = buildCaller({ id: "claimer", voiceCh });
    const r = await execute("vc_claim", {}, { member: caller }, { guild: buildGuild() });
    expect(String(r)).toMatch(/owner is still in the channel/i);
    // ownership unchanged
    expect(tempChannels.get("vc-owned")).toBe("owner-x");
  });

  it("vc_claim transfers ownership when the owner has left", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    voiceCh.members = memberCollection(); // owner gone
    tempChannels.set("vc-owned", "gone-owner");
    const caller = buildCaller({ id: "claimer", voiceCh });
    const r = await execute("vc_claim", {}, { member: caller, guild: buildGuild() }, { guild: buildGuild() });
    expect(voiceCh.permissionOverwrites.edit).toHaveBeenCalled();
    expectSafeOwnerOverwrite(voiceCh.permissionOverwrites.edit.mock.calls[0][1]);
    expect(tempChannels.get("vc-owned")).toBe("claimer");
    expect(dbMock.saveTempVc).toHaveBeenCalled();
    expect(String(r)).toMatch(/you now own/i);
  });

  it("vc_kick refuses to kick the channel owner", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    voiceCh.members = memberCollection([["owner-x", { user: { bot: false } }]]);
    tempChannels.set("vc-owned", "owner-x");
    // Caller is an admin (passes the owner/admin gate) but is NOT the owner, so
    // the "can't kick yourself" check is skipped and the owner-protection fires.
    const caller = buildCaller({ id: "admin-kicker", admin: true, voiceCh });
    const findMember = vi.fn(() => ({ id: "owner-x", user: { tag: "owner#0001" }, voice: { disconnect: vi.fn() } }));
    const r = await execute("vc_kick", { username: "owner" }, { member: caller }, { guild: buildGuild(), findMember });
    expect(String(r)).toMatch(/can't kick the channel owner/i);
  });

  it("vc_transfer reports when the target isn't in the channel", async () => {
    const voiceCh = buildVoiceChannel("vc-owned");
    voiceCh.members = memberCollection(); // target not present
    tempChannels.set("vc-owned", "caller");
    const caller = buildCaller({ id: "caller", voiceCh });
    const findMember = vi.fn(() => ({ id: "target", user: { tag: "target#0001" } }));
    const r = await execute("vc_transfer", { username: "target" }, { member: caller }, { guild: buildGuild(), findMember });
    expect(String(r)).toMatch(/isn't in your channel/i);
  });

  it("vc_transfer grants only safe owner access by Discord ID", async () => {
    const target = { id: "target-id", user: { tag: "target#0001" } };
    const voiceCh = buildVoiceChannel("vc-owned");
    voiceCh.members = memberCollection([["target-id", target]]);
    tempChannels.set("vc-owned", "caller");
    const caller = buildCaller({ id: "caller", voiceCh });
    const findMember = vi.fn((guild: any, lookup: string) => lookup === "target-id" ? target : null);

    const r = await execute("vc_transfer", { username: "target-id" }, { member: caller }, { guild: buildGuild(), findMember });

    expect(findMember).toHaveBeenCalledWith(expect.anything(), "target-id");
    expect(voiceCh.permissionOverwrites.edit).toHaveBeenCalledWith(target, expect.any(Object));
    expectSafeOwnerOverwrite(voiceCh.permissionOverwrites.edit.mock.calls[0][1]);
    expect(voiceCh.permissionOverwrites.edit).toHaveBeenCalledWith(caller, expect.objectContaining({
      ManageChannels: null,
      MoveMembers: null,
      MuteMembers: null,
      DeafenMembers: null,
    }));
    expect(tempChannels.get("vc-owned")).toBe("target-id");
    expect(String(r)).toMatch(/transferred ownership/i);
  });
});

describe("admin VC config tools", () => {
  it("set_afk_channel rejects a non-voice channel", async () => {
    const findChannel = vi.fn(() => ({ name: "general", type: ChannelType.GuildText }));
    const guild = { id: "guild-1", setAFKChannel: vi.fn(async () => {}), setAFKTimeout: vi.fn(async () => {}) };
    const r = await execute("set_afk_channel", { channel_name: "general" }, {}, { guild, findChannel });
    expect(String(r)).toMatch(/isn't a voice channel/i);
    expect(dbMock.setAfkSettings).not.toHaveBeenCalled();
  });

  it("set_afk_channel configures the AFK channel + timeout for a voice channel", async () => {
    const findChannel = vi.fn(() => ({ id: "afk1", name: "AFK", type: ChannelType.GuildVoice }));
    const guild = { id: "guild-1", setAFKChannel: vi.fn(async () => {}), setAFKTimeout: vi.fn(async () => {}) };
    const r = await execute("set_afk_channel", { channel_name: "AFK", timeout_minutes: 15 }, {}, { guild, findChannel });
    expect(dbMock.setAfkSettings).toHaveBeenCalledWith("guild-1", "afk1", 15);
    expect(guild.setAFKTimeout).toHaveBeenCalledWith(900); // 15min * 60, capped at 3600
    expect(String(r)).toMatch(/AFK channel set to "AFK"/);
  });

  it("set_vc_default_limit reports removal when the limit is 0", async () => {
    const r = await execute("set_vc_default_limit", { limit: 0 }, {}, { guild: buildGuild() });
    expect(dbMock.setVcDefaultLimit).toHaveBeenCalledWith("guild-1", 0);
    expect(String(r)).toMatch(/default vc limit removed/i);
  });

  it("set_vc_naming_mode rejects an invalid mode", async () => {
    const r = await execute("set_vc_naming_mode", { mode: "chaotic" }, {}, { guild: buildGuild() });
    expect(String(r)).toMatch(/invalid mode "chaotic"/i);
    expect(dbMock.setVcNamingMode).not.toHaveBeenCalled();
  });

  it("set_vc_naming_mode accepts a valid mode", async () => {
    const r = await execute("set_vc_naming_mode", { mode: "anonymous" }, {}, { guild: buildGuild() });
    expect(dbMock.setVcNamingMode).toHaveBeenCalledWith("guild-1", "anonymous");
    expect(String(r)).toMatch(/naming mode set to/i);
  });

  it("toggle_vc_rich_presence persists the flag and describes the effect", async () => {
    const rOn = await execute("toggle_vc_rich_presence", { enabled: true }, {}, { guild: buildGuild() });
    expect(dbMock.setVcRichPresence).toHaveBeenCalledWith("guild-1", true);
    expect(String(rOn)).toMatch(/rich presence enabled/i);

    const rOff = await execute("toggle_vc_rich_presence", { enabled: false }, {}, { guild: buildGuild() });
    expect(dbMock.setVcRichPresence).toHaveBeenCalledWith("guild-1", false);
    expect(String(rOff)).toMatch(/rich presence disabled/i);
  });
});
