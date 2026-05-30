import { describe, it, expect, beforeEach, vi } from "vitest";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/threadUpdate.js";

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => firstEntry } })),
  };
}

function makeThread(overrides: any = {}) {
  return {
    id: "thread-1",
    name: "discussion",
    archived: false,
    locked: false,
    rateLimitPerUser: 0,
    autoArchiveDuration: 1440,
    parentId: "parent-1",
    ownerId: "owner-1",
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

describe("threadUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("threadUpdate");
  });

  it("returns early when newThread.guild is missing", async () => {
    await execute(makeThread(), makeThread({ guild: null }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("does NOT log when nothing changed", async () => {
    const guild = makeGuild();
    await execute(makeThread({ guild }), makeThread({ guild }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs an archive transition", async () => {
    const guild = makeGuild();
    await execute(
      makeThread({ guild, archived: false }),
      makeThread({ guild, archived: true }),
    );
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.author.name).toContain("Thread Updated");
    const text = embedText();
    expect(text).toContain("Archived");
  });

  it("logs a lock transition and a slowmode change together", async () => {
    const guild = makeGuild();
    await execute(
      makeThread({ guild, locked: false, rateLimitPerUser: 0 }),
      makeThread({ guild, locked: true, rateLimitPerUser: 10 }),
    );
    const text = embedText();
    expect(text).toContain("Locked");
    expect(text).toContain("Slowmode");
    expect(text).toContain("10s");
  });

  it("renders 0s slowmode when rateLimitPerUser is falsy on one side", async () => {
    const guild = makeGuild();
    await execute(
      makeThread({ guild, rateLimitPerUser: undefined, name: "a" }),
      makeThread({ guild, rateLimitPerUser: 5, name: "b" }),
    );
    const text = embedText();
    expect(text).toContain("0s");
    expect(text).toContain("5s");
  });

  it("uses THREAD_UPDATE audit type (111) and attributes the actor", async () => {
    const guild = makeGuild({
      target: { id: "thread-1" },
      executor: { id: "mod-1", tag: "mod#1234" },
      createdTimestamp: Date.now(),
    });
    await execute(
      makeThread({ guild, name: "old" }),
      makeThread({ guild, name: "new" }),
    );
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 111, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@mod-1>");
  });
});
