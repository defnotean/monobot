import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActivityType, Collection } from "discord.js";

// presenceUpdate has two responsibilities:
//   1. Auto-announce when a member goes live (Streaming activity), gated on a
//      not-live -> live transition + per-user dedupe + twitch config.
//   2. Auto-rename temp VCs when a member's Playing activity changes.
// We mock getTwitchConfig + the temp-VC helpers; the EmbedBuilder is the real
// discord.js one. The streaming-dedupe map is module-level state, so each test
// uses a fresh member id to avoid cross-test bleed.

const getTwitchConfig = vi.fn(() => ({ auto_detect: false }) as any);
vi.mock("../../database.js", () => ({
  getTwitchConfig: (...a: any[]) => getTwitchConfig(...a),
}));

// vi.mock factories are hoisted above top-level consts, so the shared temp-VC
// Maps must be created inside vi.hoisted to be referenceable in the factory.
const { tempChannels, manualRenames } = vi.hoisted(() => ({
  tempChannels: new Map<string, string>(),
  manualRenames: new Map<string, number>(),
}));
vi.mock("../../utils/tempvc.js", () => ({ tempChannels, manualRenames }));

const queueRename = vi.fn();
const isActualGame = vi.fn((n: string) => n !== "Spotify");
const sanitizeGameName = vi.fn((n: string) => n);
vi.mock("../../utils/vcrenamer.js", () => ({
  queueRename: (...a: any[]) => queueRename(...a),
  isActualGame: (...a: any[]) => isActualGame(...a),
  sanitizeGameName: (...a: any[]) => sanitizeGameName(...a),
}));

const updateControlPanel = vi.fn(async () => {});
vi.mock("../../utils/vcpanel.js", () => ({
  updateControlPanel: (...a: any[]) => updateControlPanel(...a),
}));

const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({ log: (...a: any[]) => log(...a) }));

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/presenceUpdate.js";

let memberSeq = 1000;
function makeChannel() {
  return { id: "stream-ch", name: "live", send: vi.fn(async () => {}) };
}

function makeGuild(channel: any) {
  const cache = new Collection<string, any>();
  if (channel) cache.set(channel.id, channel);
  return { id: "guild-1", name: "Test Guild", channels: { cache } };
}

function streamActivity(overrides: any = {}) {
  return { type: ActivityType.Streaming, name: "Just Chatting", url: "https://twitch.tv/s", ...overrides };
}

function makePresence(guild: any, activities: any[], { bot = false, memberId = "" } = {}) {
  const id = memberId || `m-${memberSeq++}`;
  return {
    guild,
    member: {
      id,
      displayName: "Streamer",
      user: { bot, username: "streamer", displayAvatarURL: () => "https://cdn/a.png" },
      voice: { channel: null },
    },
    activities,
  };
}

beforeEach(() => {
  getTwitchConfig.mockReset().mockReturnValue({ auto_detect: false });
  queueRename.mockClear();
  updateControlPanel.mockClear();
  isActualGame.mockClear().mockImplementation((n: string) => n !== "Spotify");
  sanitizeGameName.mockClear().mockImplementation((n: string) => n);
  log.mockClear();
  tempChannels.clear();
  manualRenames.clear();
});

describe("presenceUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("presenceUpdate");
  });

  it("returns early when there is no member", async () => {
    await execute(null, { member: null, guild: null });
    expect(getTwitchConfig).not.toHaveBeenCalled();
  });

  it("ignores bot presences (bot guard fires before twitch config)", async () => {
    const guild = makeGuild(makeChannel());
    const m = `bot-${memberSeq++}`;
    const oldP = makePresence(guild, [], { bot: true, memberId: m });
    const newP = makePresence(guild, [streamActivity()], { bot: true, memberId: m });
    await execute(oldP, newP);
    expect(getTwitchConfig).not.toHaveBeenCalled();
  });

  it("does nothing when auto_detect is off", async () => {
    const ch = makeChannel();
    const guild = makeGuild(ch);
    getTwitchConfig.mockReturnValue({ auto_detect: false, channel_id: ch.id });
    const m = `m-${memberSeq++}`;
    await execute(
      makePresence(guild, [], { memberId: m }),
      makePresence(guild, [streamActivity()], { memberId: m }),
    );
    expect(ch.send).not.toHaveBeenCalled();
  });

  it("announces on the not-live -> live transition", async () => {
    const ch = makeChannel();
    const guild = makeGuild(ch);
    getTwitchConfig.mockReturnValue({ auto_detect: true, channel_id: ch.id });
    const m = `m-${memberSeq++}`;
    await execute(
      makePresence(guild, [], { memberId: m }),
      makePresence(guild, [streamActivity({ details: "come hang" })], { memberId: m }),
    );

    expect(ch.send).toHaveBeenCalledTimes(1);
    const payload = ch.send.mock.calls[0][0];
    const embed = payload.embeds[0];
    expect(embed.data.author.name).toContain("is now live");
    expect(embed.data.url).toBe("https://twitch.tv/s");
    expect(embed.data.description).toBe("come hang");
  });

  it("dedupes — a second live tick for the same member does not re-announce", async () => {
    const ch = makeChannel();
    const guild = makeGuild(ch);
    getTwitchConfig.mockReturnValue({ auto_detect: true, channel_id: ch.id });
    const m = `m-${memberSeq++}`;
    // First transition fires; an immediate second "still live" presence with no
    // prior stream would re-trigger, but the dedupe map suppresses it.
    await execute(
      makePresence(guild, [], { memberId: m }),
      makePresence(guild, [streamActivity()], { memberId: m }),
    );
    await execute(
      makePresence(guild, [], { memberId: m }),
      makePresence(guild, [streamActivity()], { memberId: m }),
    );
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it("pings configured roles in the announcement content", async () => {
    const ch = makeChannel();
    const guild = makeGuild(ch);
    getTwitchConfig.mockReturnValue({
      auto_detect: true,
      channel_id: ch.id,
      ping_role_ids: ["role-a", "role-b"],
    });
    const m = `m-${memberSeq++}`;
    await execute(
      makePresence(guild, [], { memberId: m }),
      makePresence(guild, [streamActivity()], { memberId: m }),
    );
    expect(ch.send.mock.calls[0][0].content).toBe("<@&role-a> <@&role-b>");
  });

  it("queues a temp-VC rename when the member's game changes and they own a temp VC", async () => {
    const guild = makeGuild(null);
    getTwitchConfig.mockReturnValue({ auto_detect: false });
    const m = `m-${memberSeq++}`;
    const oldP = makePresence(guild, [{ type: ActivityType.Playing, name: "Minecraft" }], { memberId: m });
    const newP = makePresence(guild, [{ type: ActivityType.Playing, name: "VALORANT" }], { memberId: m });
    const vc = { id: "vc-1", name: "game-vc" };
    newP.member.voice = { channel: vc } as any;
    tempChannels.set("vc-1", m);

    await execute(oldP, newP);

    expect(queueRename).toHaveBeenCalledWith(vc, guild);
    expect(updateControlPanel).toHaveBeenCalledWith("vc-1", guild);
  });

  it("does NOT rename when the game is unchanged", async () => {
    const guild = makeGuild(null);
    const m = `m-${memberSeq++}`;
    const same = [{ type: ActivityType.Playing, name: "Minecraft" }];
    const oldP = makePresence(guild, same, { memberId: m });
    const newP = makePresence(guild, same, { memberId: m });
    const vc = { id: "vc-2", name: "x" };
    newP.member.voice = { channel: vc } as any;
    tempChannels.set("vc-2", m);
    await execute(oldP, newP);
    expect(queueRename).not.toHaveBeenCalled();
  });

  it("skips renaming when the member is not in a registered temp VC", async () => {
    const guild = makeGuild(null);
    const m = `m-${memberSeq++}`;
    const oldP = makePresence(guild, [{ type: ActivityType.Playing, name: "Minecraft" }], { memberId: m });
    const newP = makePresence(guild, [{ type: ActivityType.Playing, name: "VALORANT" }], { memberId: m });
    newP.member.voice = { channel: { id: "not-temp", name: "x" } } as any;
    // tempChannels does NOT contain "not-temp"
    await execute(oldP, newP);
    expect(queueRename).not.toHaveBeenCalled();
    expect(updateControlPanel).not.toHaveBeenCalled();
  });
});
