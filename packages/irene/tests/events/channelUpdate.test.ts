import { describe, it, expect, beforeEach, vi } from "vitest";
import { Collection } from "discord.js";

// channelUpdate diffs many properties and only logs when at least one changed.
// Branches: no-guild early return, temp-VC skip (both maps), the per-property
// diffs (name/topic/nsfw/slowmode/category/position), the permission-overwrite
// add/remove diff, no-change early return, and audit attribution (type 11).

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));
// vi.mock is hoisted above top-level code, so these Maps must live inside
// vi.hoisted() to be initialized before the factory runs.
const { tempChannels, tempTextChannels } = vi.hoisted(() => ({
  tempChannels: new Map<string, unknown>(),
  tempTextChannels: new Map<string, string>(),
}));
vi.mock("../../utils/tempvc.js", () => ({ tempChannels, tempTextChannels }));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/channelUpdate.js";

function chan(overrides: any = {}) {
  return {
    id: "chan-1",
    name: "general",
    topic: null,
    nsfw: false,
    rateLimitPerUser: 0,
    parentId: null,
    parent: null,
    bitrate: undefined,
    userLimit: undefined,
    rawPosition: 1,
    permissionOverwrites: { cache: new Collection() },
    ...overrides,
  };
}

function guildWith({ entry = undefined, fetchThrows = false }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  return { id: "g-1", fetchAuditLogs, _fetchAuditLogs: fetchAuditLogs };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
  tempChannels.clear();
  tempTextChannels.clear();
});

describe("channelUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("channelUpdate");
  });

  it("returns early for a channel without a guild", async () => {
    await execute(chan(), chan());
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("returns early (no log) when nothing changed", async () => {
    const guild = guildWith();
    await execute(chan(), chan({ guild }));
    expect(sendModLog).not.toHaveBeenCalled();
    expect(guild._fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("skips updates on a registered temp VC", async () => {
    tempChannels.set("chan-1", {});
    await execute(chan({ name: "old" }), chan({ name: "new", guild: guildWith() }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a rename with paired before/after lines and a Name changedKey", async () => {
    const guild = guildWith();
    await execute(chan({ name: "old-name" }), chan({ name: "new-name", guild }));
    expect(guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 11, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.description).toContain("`Name`");
    expect(payload.fields[0].value).toContain("old-name");
    expect(payload.fields[1].value).toContain("new-name");
  });

  it("detects multiple simultaneous changes (nsfw + slowmode + position)", async () => {
    const guild = guildWith();
    await execute(
      chan({ nsfw: false, rateLimitPerUser: 0, rawPosition: 1 }),
      chan({ nsfw: true, rateLimitPerUser: 10, rawPosition: 4, guild }),
    );
    const payload = logEvent.mock.calls[0][0];
    expect(payload.description).toContain("`NSFW`");
    expect(payload.description).toContain("`Slowmode`");
    expect(payload.description).toContain("`Position`");
    expect(payload.fields[1].value).toContain("10s");
  });

  it("diffs permission-overwrite additions and removals", async () => {
    const oldCache = new Collection<string, any>();
    oldCache.set("role-old", { type: 0 });
    const newCache = new Collection<string, any>();
    newCache.set("member-new", { type: 1 });
    const guild = guildWith();
    await execute(
      chan({ permissionOverwrites: { cache: oldCache } }),
      chan({ permissionOverwrites: { cache: newCache }, guild }),
    );
    const payload = logEvent.mock.calls[0][0];
    expect(payload.description).toContain("`Permissions`");
    // added member overwrite (type 1) rendered as a user mention
    expect(payload.fields[0].value).toContain("<@member-new>");
    // removed role overwrite rendered as a role mention
    expect(payload.fields[1].value).toContain("<@&role-old>");
  });

  it("attributes the actor from a fresh type-11 audit entry", async () => {
    const guild = guildWith({
      entry: { target: { id: "chan-1" }, executor: { id: "mod-x" }, reason: "rename", createdTimestamp: Date.now() },
    });
    await execute(chan({ name: "a" }), chan({ name: "b", guild }));
    expect(logEvent.mock.calls[0][0].actor).toEqual({ id: "mod-x" });
  });
});
