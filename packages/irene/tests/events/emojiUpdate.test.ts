import { describe, it, expect, beforeEach, vi } from "vitest";

// emojiUpdate only logs RENAMES (name changed). Branches: the no-name-change
// early return, the rename log with before/after meta, animated preview, and
// audit attribution (type 61).

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/emojiUpdate.js";

function emoji(overrides: any = {}) {
  return { id: "e-3", name: "smile", animated: false, url: "https://cdn/e-3.png", ...overrides };
}

function guildWith({ entry = undefined }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => ({ entries: { first: () => entry ?? null } }));
  return { fetchAuditLogs, _fetchAuditLogs: fetchAuditLogs };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("emojiUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("emojiUpdate");
  });

  it("returns early WITHOUT logging when the name did not change", async () => {
    const guild = guildWith();
    await execute(emoji({ name: "smile" }), emoji({ name: "smile", guild }));
    expect(sendModLog).not.toHaveBeenCalled();
    expect(guild._fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("logs a rename with before/after names and queries the type-61 audit", async () => {
    const guild = guildWith();
    await execute(emoji({ name: "smile" }), emoji({ name: "grin", guild }));
    expect(guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 61, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Emoji Renamed");
    expect(payload.meta["Before"]).toBe("`:smile:`");
    expect(payload.meta["After"]).toBe("`:grin:`");
  });

  it("uses the animated preview when the new emoji is animated", async () => {
    const guild = guildWith();
    await execute(emoji({ name: "a" }), emoji({ name: "b", animated: true, guild }));
    expect(logEvent.mock.calls[0][0].description).toContain("<a:b:e-3>");
  });

  it("attributes a fresh audit actor", async () => {
    const guild = guildWith({
      entry: { target: { id: "e-3" }, executor: { id: "mod-r" }, reason: "tidy", createdTimestamp: Date.now() },
    });
    await execute(emoji({ name: "x" }), emoji({ name: "y", guild }));
    expect(logEvent.mock.calls[0][0].actor).toEqual({ id: "mod-r" });
  });
});
