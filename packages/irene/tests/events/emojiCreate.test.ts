import { describe, it, expect, beforeEach, vi } from "vitest";

// emojiCreate logs added emoji with the EMOJI_CREATE audit (type 60). Branches:
// animated vs static preview, the managed-emoji meta line, actor attribution,
// and the throwing-audit fallback.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/emojiCreate.js";

function makeEmoji({ entry = undefined, fetchThrows = false, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  return {
    id: "e-1",
    name: "blob",
    animated: false,
    managed: false,
    url: "https://cdn/e-1.png",
    guild: { fetchAuditLogs, _fetchAuditLogs: fetchAuditLogs },
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("emojiCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("emojiCreate");
  });

  it("logs a static emoji with the <:name:id> preview and image", async () => {
    const emoji = makeEmoji();
    await execute(emoji);
    expect(emoji.guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 60, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Emoji Added");
    expect(payload.meta["Shortcut"]).toBe("<:blob:e-1>");
    expect(payload.meta["Animated"]).toContain("no");
    expect(payload.image).toBe("https://cdn/e-1.png");
    expect(payload.meta["Managed"]).toBeNull();
  });

  it("uses the animated <a:name:id> preview and flags managed emoji", async () => {
    const emoji = makeEmoji({ animated: true, managed: true });
    await execute(emoji);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.meta["Shortcut"]).toBe("<a:blob:e-1>");
    expect(payload.meta["Animated"]).toContain("yes");
    expect(payload.meta["Managed"]).toBe("yes (integration)");
  });

  it("attributes a fresh audit actor", async () => {
    const emoji = makeEmoji({
      entry: { target: { id: "e-1" }, executor: { id: "mod-e" }, reason: "added", createdTimestamp: Date.now() },
    });
    await execute(emoji);
    expect(logEvent.mock.calls[0][0].actor).toEqual({ id: "mod-e" });
    expect(logEvent.mock.calls[0][0].description).toContain("by <@mod-e>");
  });

  it("still logs when the audit fetch throws", async () => {
    const emoji = makeEmoji({ fetchThrows: true });
    await expect(execute(emoji)).resolves.not.toThrow();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0].actor).toBeNull();
  });
});
