import { describe, it, expect, beforeEach, vi } from "vitest";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/threadDelete.js";

function makeGuild(firstEntry: any = null) {
  return {
    id: "guild-1",
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => firstEntry } })),
  };
}

function makeThread(overrides: any = {}) {
  return {
    id: "thread-1",
    name: "deleted-thread",
    parentId: "parent-9",
    ownerId: "owner-1",
    messageCount: 12,
    createdTimestamp: Date.now() - 3_600_000,
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

describe("threadDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("threadDelete");
  });

  it("returns early when thread has no guild", async () => {
    await execute(makeThread({ guild: null }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a Thread Deleted embed using the thread name, id and parent", async () => {
    await execute(makeThread());
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.author.name).toContain("Thread Deleted");
    const text = embedText();
    expect(text).toContain("deleted-thread");
    expect(text).toContain("thread-1");
    expect(text).toContain("<#parent-9>");
    expect(text).toContain("12"); // messageCount
  });

  it("shows '(unknown)' parent when parentId is missing", async () => {
    await execute(makeThread({ parentId: null }));
    expect(embedText()).toContain("(unknown)");
  });

  it("uses THREAD_DELETE audit type (112) and attributes the deleter", async () => {
    const guild = makeGuild({
      target: { id: "thread-1" },
      executor: { id: "mod-1", tag: "mod#1234" },
      createdTimestamp: Date.now(),
    });
    await execute(makeThread({ guild }));
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 112, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@mod-1>");
  });
});
