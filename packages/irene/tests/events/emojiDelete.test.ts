import { describe, it, expect, beforeEach, vi } from "vitest";

// emojiDelete logs removed emoji via the EMOJI_DELETE audit (type 62). Branches:
// age calculation when createdTimestamp present vs absent, actor attribution,
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
import { execute, name } from "../../events/emojiDelete.js";

function makeEmoji({ entry = undefined, fetchThrows = false, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  return {
    id: "e-2",
    name: "wave",
    animated: false,
    createdTimestamp: Date.now() - 5 * 86_400_000,
    url: "https://cdn/e-2.png",
    guild: { fetchAuditLogs, _fetchAuditLogs: fetchAuditLogs },
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("emojiDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("emojiDelete");
  });

  it("logs a removal with age computed from createdTimestamp", async () => {
    const emoji = makeEmoji();
    await execute(emoji);
    expect(emoji.guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 62, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.title).toBe("Emoji Removed");
    expect(payload.color).toBe(0xed4245);
    expect(payload.meta["Age"]).toBe("5d");
    expect(payload.meta["Name"]).toBe("`:wave:`");
  });

  it("omits Age/Created when createdTimestamp is missing", async () => {
    const emoji = makeEmoji({ createdTimestamp: null });
    await execute(emoji);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.meta["Age"]).toBeNull();
    expect(payload.meta["Created"]).toBeNull();
  });

  it("attributes a fresh audit actor", async () => {
    const emoji = makeEmoji({
      entry: { target: { id: "e-2" }, executor: { id: "mod-d" }, reason: "spam emoji", createdTimestamp: Date.now() },
    });
    await execute(emoji);
    expect(logEvent.mock.calls[0][0].actor).toEqual({ id: "mod-d" });
  });

  it("still logs when the audit fetch throws", async () => {
    const emoji = makeEmoji({ fetchThrows: true });
    await expect(execute(emoji)).resolves.not.toThrow();
    expect(sendModLog).toHaveBeenCalledTimes(1);
  });
});
