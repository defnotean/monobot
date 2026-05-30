import { describe, it, expect, beforeEach, vi } from "vitest";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/stickerUpdate.js";

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => firstEntry } })),
  };
}

function makeSticker(overrides: any = {}) {
  return {
    id: "sticker-1",
    name: "Pog",
    description: "",
    tags: "😀",
    format: 1,
    url: "https://cdn/s.png",
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

describe("stickerUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("stickerUpdate");
  });

  it("returns early when newSticker.guild is missing", async () => {
    await execute(makeSticker(), makeSticker({ guild: null }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("does NOT log when nothing changed", async () => {
    const guild = makeGuild();
    await execute(makeSticker({ guild }), makeSticker({ guild }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a name change diff", async () => {
    const guild = makeGuild();
    await execute(
      makeSticker({ guild, name: "Pog" }),
      makeSticker({ guild, name: "Sadge" }),
    );
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(sendModLog.mock.calls[0][1].data.author.name).toContain("Sticker Updated");
    const text = embedText();
    expect(text).toContain("Pog");
    expect(text).toContain("Sadge");
    expect(text).toContain("Name");
  });

  it("logs a description change, rendering '(none)' for the empty old value", async () => {
    const guild = makeGuild();
    await execute(
      makeSticker({ guild, description: "" }),
      makeSticker({ guild, description: "now has text" }),
    );
    const text = embedText();
    expect(text).toContain("(none)");
    expect(text).toContain("now has text");
  });

  it("logs an emoji-tag change and attributes the actor via STICKER_UPDATE (91)", async () => {
    const guild = makeGuild({
      target: { id: "sticker-1" },
      executor: { id: "editor-1", tag: "editor#0001" },
      createdTimestamp: Date.now(),
    });
    await execute(
      makeSticker({ guild, tags: "😀" }),
      makeSticker({ guild, tags: "😎" }),
    );
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 91, limit: 1 });
    const text = embedText();
    expect(text).toContain("😀");
    expect(text).toContain("😎");
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@editor-1>");
  });
});
