import { describe, it, expect, beforeEach, vi } from "vitest";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/stickerDelete.js";

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => firstEntry } })),
  };
}

function makeSticker(overrides: any = {}) {
  return {
    id: "sticker-7",
    name: "ByeBye",
    description: "",
    format: 1,
    url: "https://cdn/s.png",
    createdTimestamp: Date.now() - 86_400_000,
    ...overrides,
    guild: "guild" in overrides ? overrides.guild : makeGuild(),
  };
}

function embedText() {
  return JSON.stringify(sendModLog.mock.calls[0][1].data);
}

beforeEach(() => {
  sendModLog.mockClear();
});

describe("stickerDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("stickerDelete");
  });

  it("returns early when sticker has no guild", async () => {
    await execute(makeSticker({ guild: null }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a Sticker Removed embed with the sticker name and id", async () => {
    await execute(makeSticker());
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.author.name).toContain("Sticker Removed");
    const text = embedText();
    expect(text).toContain("ByeBye");
    expect(text).toContain("sticker-7");
  });

  it("uses STICKER_DELETE audit type (92) and attributes the deleter", async () => {
    const guild = makeGuild({
      target: { id: "sticker-7" },
      executor: { id: "mod-9", tag: "mod#9999" },
      createdTimestamp: Date.now(),
    });
    await execute(makeSticker({ guild }));
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 92, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@mod-9>");
  });

  it("ignores a stale audit entry (older than 5s)", async () => {
    const guild = makeGuild({
      target: { id: "sticker-7" },
      executor: { id: "mod-9", tag: "mod#9999" },
      createdTimestamp: Date.now() - 9000,
    });
    await execute(makeSticker({ guild }));
    expect(sendModLog.mock.calls[0][1].data.description).not.toContain("<@mod-9>");
  });
});
