import { describe, it, expect, beforeEach, vi } from "vitest";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/stickerCreate.js";

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
    url: "https://cdn/sticker.png",
    createdTimestamp: Date.now(),
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

describe("stickerCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("stickerCreate");
  });

  it("returns early when sticker has no guild", async () => {
    await execute(makeSticker({ guild: null }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a Sticker Added embed with name, id and PNG format", async () => {
    await execute(makeSticker());
    const embed = sendModLog.mock.calls[0][1];
    // logEvent prefixes the author name with a per-kind icon, e.g. "📋  Sticker Added".
    expect(embed.data.author.name).toContain("Sticker Added");
    const text = embedText();
    expect(text).toContain("Pog");
    expect(text).toContain("sticker-1");
    expect(text).toContain("PNG");
  });

  it("renders '(none)' for an empty description, shows real text otherwise", async () => {
    await execute(makeSticker({ description: "" }));
    expect(embedText()).toContain("(none)");

    sendModLog.mockClear();
    await execute(makeSticker({ description: "a cool sticker" }));
    expect(embedText()).toContain("a cool sticker");
  });

  it("uses STICKER_CREATE audit type (90) and attributes the actor in the description", async () => {
    const guild = makeGuild({
      target: { id: "sticker-1" },
      executor: { id: "artist-1", tag: "artist#0001" },
      createdTimestamp: Date.now(),
    });
    await execute(makeSticker({ guild }));
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 90, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@artist-1>");
  });

  it("labels GIF format for format type 4", async () => {
    await execute(makeSticker({ format: 4 }));
    expect(embedText()).toContain("GIF");
  });
});
