import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelType } from "discord.js";

// channelDelete logs deletions AND feeds the anti-nuke tracker. Branches:
// no-guild early return, bot-deleted skip, actor attribution, and the anti-nuke
// trackAction call which must fire only for a real (non-bot) actor.

const sendModLog = vi.fn(async () => {});
const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
  log: (...args: any[]) => log(...args),
}));
const logEvent = vi.fn((opts: any) => opts);
vi.mock("../../utils/embeds.js", () => ({
  logEvent: (...args: any[]) => logEvent(...args),
}));
const trackAction = vi.fn(() => Promise.resolve());
vi.mock("../../utils/antinuke.js", () => ({
  trackAction: (...args: any[]) => trackAction(...args),
}));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/channelDelete.js";

const BOT_ID = "bot-self";

function makeChannel({ entry = undefined, fetchThrows = false, guild = true, ...overrides }: any = {}) {
  const fetchAuditLogs = vi.fn(async () => {
    if (fetchThrows) throw new Error("no perms");
    return { entries: { first: () => entry ?? null } };
  });
  const guildObj = guild
    ? { id: "guild-1", fetchAuditLogs, client: { user: { id: BOT_ID } }, _fetchAuditLogs: fetchAuditLogs }
    : null;
  return {
    id: "chan-7",
    name: "old-room",
    type: ChannelType.GuildText,
    parent: null,
    rawPosition: 1,
    createdTimestamp: Date.now() - 2 * 86_400_000,
    guild: guildObj,
    ...overrides,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  logEvent.mockClear();
  trackAction.mockClear();
  log.mockClear();
});

describe("channelDelete", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("channelDelete");
  });

  it("returns early for a channel without a guild", async () => {
    await execute(makeChannel({ guild: false }));
    expect(sendModLog).not.toHaveBeenCalled();
    expect(trackAction).not.toHaveBeenCalled();
  });

  it("logs a deletion and queries the delete audit (type 12)", async () => {
    const ch = makeChannel();
    await execute(ch);
    expect(ch.guild._fetchAuditLogs).toHaveBeenCalledWith({ type: 12, limit: 1 });
    const payload = logEvent.mock.calls[0][0];
    expect(payload.description).toContain("was deleted");
    expect(payload.color).toBe(0xed4245);
  });

  it("SKIPS logging entirely when the audit shows the bot deleted the channel", async () => {
    const ch = makeChannel({
      entry: { target: { id: "chan-7" }, executor: { id: BOT_ID }, createdTimestamp: Date.now() },
    });
    await execute(ch);
    expect(sendModLog).not.toHaveBeenCalled();
    expect(trackAction).not.toHaveBeenCalled();
  });

  it("fires the anti-nuke tracker for a human actor", async () => {
    const ch = makeChannel({
      entry: { target: { id: "chan-7" }, executor: { id: "raider" }, reason: "nuke", createdTimestamp: Date.now() },
    });
    await execute(ch);
    expect(trackAction).toHaveBeenCalledWith("guild-1", "raider", "channel_delete", ch.guild);
    expect(logEvent.mock.calls[0][0].description).toContain("by <@raider>");
  });

  it("does NOT call the anti-nuke tracker when there is no attributed actor", async () => {
    const ch = makeChannel({ entry: undefined }); // no audit entry -> actor stays null
    await execute(ch);
    expect(sendModLog).toHaveBeenCalledTimes(1);
    expect(trackAction).not.toHaveBeenCalled();
  });
});
