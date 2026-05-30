import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelType } from "discord.js";

// channelCreate logs new channels with audit attribution. Key branches:
// the no-guild early return, the bot-created skip (when the audit executor is
// the bot user), actor attribution for a fresh entry, channel-type label
// mapping, voice-only meta (bitrate/user-limit), and the throwing-audit path.

const sendModLog = vi.fn(async () => {});
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/channelCreate.js";

const BOT_ID = "bot-self";

function makeChannel({ entry = undefined, fetchThrows = false, guild = true, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  const guildObj = guild
    ? { fetchAuditLogs, client: { user: { id: BOT_ID } }, _fetchAuditLogs: fetchAuditLogs }
    : null;
  return {
    id: "chan-1",
    name: "general",
    type: ChannelType.GuildText,
    parent: null,
    rawPosition: 3,
    nsfw: false,
    rateLimitPerUser: 0,
    guild: guildObj,
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
});

describe("channelCreate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("channelCreate");
  });

  it("returns early for a channel without a guild (DM/group)", async () => {
    await execute(makeChannel({ guild: false }));
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("logs a text channel with the mapped type label", async () => {
    const ch = makeChannel();
    await execute(ch);
    expect(ch.guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 10, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.meta["Type"]).toBe("Text");
    expect(payload.description).toContain("Text channel");
  });

  it("SKIPS logging when the audit shows the channel was bot-created", async () => {
    const ch = makeChannel({
      entry: { target: { id: "chan-1" }, executor: { id: BOT_ID }, createdTimestamp: Date.now() },
    });
    await execute(ch);
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("attributes a human actor from a fresh matching entry", async () => {
    const ch = makeChannel({
      entry: { target: { id: "chan-1" }, executor: { id: "human-mod" }, reason: "new room", createdTimestamp: Date.now() },
    });
    await execute(ch);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.actor).toEqual({ id: "human-mod" });
    expect(payload.description).toContain("by <@human-mod>");
  });

  it("renders voice-only meta (bitrate + user limit) for a voice channel", async () => {
    const ch = makeChannel({
      type: ChannelType.GuildVoice,
      bitrate: 64000,
      userLimit: 5,
    });
    await execute(ch);
    const payload = logEvent.mock.calls[0][0];
    expect(payload.meta["Type"]).toBe("Voice");
    expect(payload.meta["Bitrate"]).toBe("64kbps");
    expect(payload.meta["User Limit"]).toBe("5");
  });

  it("falls back to a numeric type label for an unknown channel type and still logs when audit throws", async () => {
    const ch = makeChannel({ type: 123, fetchThrows: true });
    await expect(execute(ch)).resolves.not.toThrow();
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0].meta["Type"]).toBe("type 123");
  });
});
