import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelType } from "discord.js";

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...a: any[]) => sendModLog(...a),
  log: vi.fn(),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/threadCreate.js";

function makeGuild(firstEntry: any = null, owner: any = null) {
  return {
    id: "guild-1",
    client: { users: { fetch: vi.fn(async () => owner) } },
    fetchAuditLogs: vi.fn(async () => ({ entries: { first: () => firstEntry } })),
  };
}

function makeThread(overrides: any = {}) {
  return {
    id: "thread-1",
    name: "general-help",
    type: ChannelType.PublicThread,
    parentId: "parent-1",
    parent: { name: "general" },
    ownerId: "owner-42",
    autoArchiveDuration: 1440,
    rateLimitPerUser: 0,
    invitable: true,
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

describe("threadCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("threadCreate");
  });

  it("returns early when not newly created", async () => {
    await execute(makeThread(), false);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("returns early when thread has no guild", async () => {
    await execute(makeThread({ guild: null }), true);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a public thread with mention, id, parent and type", async () => {
    await execute(makeThread(), true);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.author.name).toContain("Thread Created");
    const text = embedText();
    expect(text).toContain("<#thread-1>");
    expect(text).toContain("thread-1");
    expect(text).toContain("Public Thread");
    expect(text).toContain("<#parent-1>");
    expect(text).toContain("24 hours"); // autoArchive 1440
  });

  it("labels a private thread distinctly", async () => {
    await execute(makeThread({ type: ChannelType.PrivateThread }), true);
    expect(embedText()).toContain("Private Thread");
  });

  it("resolves the creator from the thread owner and attributes them", async () => {
    const owner = { id: "owner-42", tag: "creator#0001" };
    const guild = makeGuild(null, owner);
    await execute(makeThread({ guild }), true);
    expect(guild.client.users.fetch).toHaveBeenCalledWith("owner-42");
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@owner-42>");
  });

  it("falls back to the THREAD_CREATE audit log (type 110) when owner fetch yields nothing", async () => {
    const guild = makeGuild(
      { target: { id: "thread-1" }, executor: { id: "mod-7", tag: "mod#7" }, createdTimestamp: Date.now() },
      null, // users.fetch returns null
    );
    await execute(makeThread({ guild, ownerId: null }), true);
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: 110, limit: 1 });
    expect(sendModLog.mock.calls[0][1].data.description).toContain("<@mod-7>");
  });
});
