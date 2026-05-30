import { describe, it, expect, beforeEach, vi } from "vitest";

// channelPinsUpdate identifies who pinned/unpinned by racing the MESSAGE_PIN (74)
// and MESSAGE_UNPIN (75) audit logs and picking the most recent fresh entry.
// Branches exercised: no-guild early return, temp-VC-text skip, pin-only,
// unpin-only, both-present (most recent wins), and neither-fresh ("changed").

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));
// Controllable temp-channel set; default empty so the skip does not fire.
// vi.mock is hoisted above top-level code, so the Map must live inside
// vi.hoisted() to be initialized before the factory runs.
const { tempTextChannels } = vi.hoisted(() => ({ tempTextChannels: new Map<string, string>() }));
vi.mock("../../utils/tempvc.js", () => ({
  tempTextChannels,
  tempChannels: new Map(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/channelPinsUpdate.js";

function auditFor(entry: any) {
  return { entries: { first: () => entry ?? null } };
}

// fetchAuditLogs is called once per type; route by the `type` option.
function makeChannel({ pinEntry = null, unpinEntry = null, guild = true, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async (opts: any) => {
    if (opts.type === 74) return auditFor(pinEntry);
    if (opts.type === 75) return auditFor(unpinEntry);
    return auditFor(null);
  });
  const guildObj = guild ? { id: "g-1", fetchAuditLogs } : null;
  return { id: "chan-1", name: "general", guild: guildObj, ...overrides };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
  tempTextChannels.clear();
});

describe("channelPinsUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("channelPinsUpdate");
  });

  it("returns early for a channel without a guild", async () => {
    await execute(makeChannel({ guild: false }), Date.now());
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("skips pin events fired inside a temp-VC text channel", async () => {
    tempTextChannels.set("vc-owner", "chan-1");
    await execute(makeChannel(), Date.now());
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("reports a pin with the pinning moderator when only a fresh pin entry exists", async () => {
    const ch = makeChannel({
      pinEntry: { executor: { id: "mod-1", tag: "mod#1", bot: false }, extra: { messageId: "m-99" }, createdTimestamp: Date.now() },
    });
    await execute(ch, Date.now());
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Message Pinned");
    expect(payload.kind).toBe("pin");
    expect(payload.description).toContain("pinned a message");
    expect(payload.meta["Message"]).toContain("m-99");
    expect(payload.meta["Message"]).toContain("jump");
  });

  it("reports an unpin when only a fresh unpin entry exists", async () => {
    const ch = makeChannel({
      unpinEntry: { executor: { id: "mod-2", tag: "mod#2", bot: false }, target: { id: "m-7" }, createdTimestamp: Date.now() },
    });
    await execute(ch, Date.now());
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Message Unpinned");
    expect(payload.kind).toBe("unpin");
    expect(payload.meta["Action"]).toBe("unpinned");
  });

  it("when both are fresh, the more recent entry wins", async () => {
    const ch = makeChannel({
      pinEntry: { executor: { id: "pinner" }, extra: { messageId: "p" }, createdTimestamp: Date.now() - 100 },
      unpinEntry: { executor: { id: "unpinner" }, extra: { messageId: "u" }, createdTimestamp: Date.now() },
    });
    await execute(ch, Date.now());
    const payload = logEvent.mock.calls[0][0];
    // unpin is newer -> action is unpinned, actor is the unpinner
    expect(payload.meta["Action"]).toBe("unpinned");
    expect(payload.description).toContain("<@unpinner>");
  });

  it("falls back to a generic 'changed' log when no fresh audit entry is found", async () => {
    const ch = makeChannel({
      pinEntry: { executor: { id: "old" }, createdTimestamp: Date.now() - 60_000 }, // stale
    });
    await execute(ch, Date.now());
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Pins Updated");
    expect(payload.kind).toBe("audit");
    expect(payload.meta["Moderator"]).toBe("*(unknown)*");
  });
});
