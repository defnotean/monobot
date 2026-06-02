import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChannelType, Collection } from "discord.js";

// ─── Mock collaborators ──────────────────────────────────────────────────────
// voiceStateUpdate touches the mod-log channel, several persistence helpers,
// the temp-VC maps, the auto-renamer, and the control-panel renderer.  We mock
// each one so the assertions can focus on the handler's branching: join/leave/
// move, ignore-bot, temp-VC auto-delete, and create-VC trigger flow.

const sendModLog = vi.fn(async () => {});
const log = vi.fn();
vi.mock("../../utils/logger.js", () => ({
  sendModLog: (...args: any[]) => sendModLog(...args),
  log: (...args: any[]) => log(...args),
}));

const getGuildSettings = vi.fn(() => null as any);
const isDmOptout = vi.fn(() => false);
const getVcTemplate = vi.fn(() => "{username}'s VC");
const getVcDefaultLimit = vi.fn(() => 0);
const saveTempVc = vi.fn();
const deleteTempVc = vi.fn();
const addVoiceTime = vi.fn();
const getVerificationRole = vi.fn(() => null as string | null);
vi.mock("../../database.js", () => ({
  getGuildSettings: (...a: any[]) => getGuildSettings(...a),
  isDmOptout: (...a: any[]) => isDmOptout(...a),
  getVcTemplate: (...a: any[]) => getVcTemplate(...a),
  getVcDefaultLimit: (...a: any[]) => getVcDefaultLimit(...a),
  saveTempVc: (...a: any[]) => saveTempVc(...a),
  deleteTempVc: (...a: any[]) => deleteTempVc(...a),
  addVoiceTime: (...a: any[]) => addVoiceTime(...a),
  getVerificationRole: (...a: any[]) => getVerificationRole(...a),
}));

const applyVcTemplate = vi.fn((_tpl: string, m: any) => `${m.user.username}'s VC`);
const queueRename = vi.fn();
const initRenameTimer = vi.fn();
vi.mock("../../utils/vcrenamer.js", () => ({
  applyVcTemplate: (...a: any[]) => applyVcTemplate(...a),
  queueRename: (...a: any[]) => queueRename(...a),
  initRenameTimer: (...a: any[]) => initRenameTimer(...a),
}));

const createControlPanel = vi.fn(async () => {});
const updateControlPanel = vi.fn(async () => {});
vi.mock("../../utils/vcpanel.js", () => ({
  createControlPanel: (...a: any[]) => createControlPanel(...a),
  updateControlPanel: (...a: any[]) => updateControlPanel(...a),
}));

// embeds.js — only logEvent is used by voiceStateUpdate, but we keep the
// real implementation so the embed.data shape stays realistic for assertions.
// (No vi.mock for embeds — let the real module run.)

// @ts-expect-error — JS module, no types
import { execute, name } from "../../events/voiceStateUpdate.js";
// @ts-expect-error — JS module, no types
import * as tempvc from "../../utils/tempvc.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeUser(overrides: any = {}) {
  return {
    id: "111111111111111111",
    tag: "alice#0001",
    username: "alice",
    bot: false,
    displayAvatarURL: () => "https://cdn/avatar.png",
    createDM: vi.fn(async () => ({
      send: vi.fn(async () => ({ delete: vi.fn() })),
      createMessageCollector: vi.fn(() => ({
        on: vi.fn(),
        stop: vi.fn(),
      })),
    })),
    ...overrides,
  };
}

function makeGuild({ settings = null as any, channels = new Collection<string, any>() }: any = {}) {
  const guild: any = {
    id: "999999999999999999",
    name: "Test Guild",
    fetchAuditLogs: vi.fn(async () => ({
      entries: { values: () => [].values() },
    })),
    channels: { cache: channels },
    roles: { everyone: { id: "999999999999999999" }, cache: new Collection() },
    members: { cache: new Collection(), fetch: vi.fn() },
    client: { user: { id: "888888888888888888" }, guilds: { cache: new Collection() } },
  };
  // Make sendModLog's "is bot still in guild" check succeed.
  guild.client.guilds.cache.set(guild.id, guild);
  guild.members.me = { id: guild.client.user.id };
  if (settings) getGuildSettings.mockReturnValue(settings);
  return guild;
}

function makeChannel(id: string, name = "general", { members = [] as any[], parent = null }: any = {}) {
  const cache = new Collection<string, any>();
  for (const m of members) cache.set(m.id, m);
  return {
    id,
    name,
    type: ChannelType.GuildVoice,
    members: cache,
    userLimit: 0,
    bitrate: 64000,
    parent,
    position: 1,
    permissionOverwrites: { edit: vi.fn(async () => {}), delete: vi.fn(async () => {}), cache: new Collection() },
    delete: vi.fn(async () => {}),
  };
}

function makeState({ channel = null as any, member = null as any, guild, ...flags }: any) {
  return {
    channel,
    member,
    guild,
    selfMute: false,
    selfDeaf: false,
    streaming: false,
    selfVideo: false,
    mute: false,
    deaf: false,
    serverMute: false,
    serverDeaf: false,
    ...flags,
  };
}

beforeEach(() => {
  sendModLog.mockClear();
  log.mockClear();
  getGuildSettings.mockReset().mockReturnValue(null);
  isDmOptout.mockClear().mockReturnValue(false);
  getVcTemplate.mockClear().mockReturnValue("{username}'s VC");
  getVcDefaultLimit.mockClear().mockReturnValue(0);
  saveTempVc.mockClear();
  deleteTempVc.mockClear();
  addVoiceTime.mockClear();
  getVerificationRole.mockClear().mockReturnValue(null);
  applyVcTemplate.mockClear();
  queueRename.mockClear();
  initRenameTimer.mockClear();
  createControlPanel.mockClear();
  updateControlPanel.mockClear();
  // Wipe shared temp VC maps so cross-test state doesn't bleed.
  tempvc.tempChannels.clear();
  tempvc.pendingCreateVcUsers.clear();
  tempvc.tempTextChannels.clear();
  tempvc.tempVcSeq.clear();
  tempvc.tempControlPanels.clear();
  tempvc.renameTimers.clear();
  tempvc.tempVcCreatedAt.clear();
  tempvc.tempVcMembers.clear();
  tempvc.ownerGraceTimers.clear();
  tempvc.manualRenames.clear();
  tempvc.guildVcSeqCounters.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("voiceStateUpdate", () => {
  it("exports the discord event name", () => {
    expect(name).toBe("voiceStateUpdate");
  });

  it("ignores bot voice state changes entirely", async () => {
    const guild = makeGuild();
    const botUser = makeUser({ id: "888888888888888888", bot: true });
    const member = { id: botUser.id, user: botUser, guild };
    const newCh = makeChannel("ch-1", "general", { members: [member] });
    const oldState = makeState({ channel: null, member, guild });
    const newState = makeState({ channel: newCh, member, guild });

    await execute(oldState, newState);

    expect(sendModLog).not.toHaveBeenCalled();
    expect(addVoiceTime).not.toHaveBeenCalled();
    expect(queueRename).not.toHaveBeenCalled();
  });

  it("logs a voiceJoin embed when a user joins voice", async () => {
    const guild = makeGuild();
    const user = makeUser();
    const member = { id: user.id, user, guild };
    const newCh = makeChannel("ch-100", "lobby", { members: [member] });
    const oldState = makeState({ channel: null, member, guild });
    const newState = makeState({ channel: newCh, member, guild });

    await execute(oldState, newState);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    const [guildArg, embed] = sendModLog.mock.calls[0];
    expect(guildArg).toBe(guild);
    expect(embed.data.author.name).toMatch(/Voice/i);
    expect(embed.data.description).toContain(`<@${user.id}>`);
    expect(embed.data.description).toContain(`<#${newCh.id}>`);
  });

  it("logs a leave embed and accumulates voice time when user leaves voice", async () => {
    const guild = makeGuild();
    const user = makeUser();
    const member = { id: user.id, user, guild };
    const oldCh = makeChannel("ch-200", "lobby", { members: [member] });
    const oldState = makeState({ channel: oldCh, member, guild });
    const newState = makeState({ channel: null, member, guild });

    // Pretend the user joined a while ago so addVoiceTime sees > 0 minutes.
    // The handler keys its session map by `${guildId}-${userId}`, but that
    // private map isn't exported — the public side effect we observe is the
    // leave embed; voice-time accumulation only triggers when there was an
    // active session for this process, so we don't assert the exact minutes.
    await execute(oldState, newState);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain(`<#${oldCh.id}>`);
    // Either "left" or "disconnected" wording — both are leave-flavoured.
    expect(embed.data.description).toMatch(/left|disconnected/i);
  });

  it("logs a voiceMove embed when a user switches between channels", async () => {
    const guild = makeGuild();
    const user = makeUser();
    const member = { id: user.id, user, guild };
    const oldCh = makeChannel("ch-A", "alpha", { members: [] });
    const newCh = makeChannel("ch-B", "bravo", { members: [member] });
    const oldState = makeState({ channel: oldCh, member, guild });
    const newState = makeState({ channel: newCh, member, guild });

    await execute(oldState, newState);

    expect(sendModLog).toHaveBeenCalledTimes(1);
    const embed = sendModLog.mock.calls[0][1];
    expect(embed.data.description).toContain(`<#${oldCh.id}>`);
    expect(embed.data.description).toContain(`<#${newCh.id}>`);
    expect(embed.data.author.name).toMatch(/Voice Moved|Voice/i);
  });

  it("auto-deletes an empty temp VC and clears its state", async () => {
    const guild = makeGuild();
    const user = makeUser();
    const member = { id: user.id, user, guild };

    // Temp VC is registered + empty after the user leaves.
    const tempVc = makeChannel("temp-1", "alice's VC", { members: [] });
    guild.channels.cache.set(tempVc.id, tempVc);
    tempvc.tempChannels.set(tempVc.id, user.id);
    tempvc.tempVcCreatedAt.set(tempVc.id, new Date(Date.now() - 60_000));
    tempvc.tempVcMembers.set(tempVc.id, new Set([user.id]));

    const oldState = makeState({ channel: tempVc, member, guild });
    const newState = makeState({ channel: null, member, guild });

    await execute(oldState, newState);

    // Channel was deleted on Discord side + persistence row removed.
    expect(tempVc.delete).toHaveBeenCalled();
    expect(deleteTempVc).toHaveBeenCalledWith(tempVc.id);
    // In-memory state cleaned up.
    expect(tempvc.tempChannels.has(tempVc.id)).toBe(false);
    expect(tempvc.tempVcCreatedAt.has(tempVc.id)).toBe(false);
    expect(tempvc.tempVcMembers.has(tempVc.id)).toBe(false);
  });

  it("create-VC trigger: spawns a new channel and moves the joining user into it", async () => {
    const guild = makeGuild({
      settings: { create_vc_channel_id: "trigger-9" },
    });
    const user = makeUser({ id: "222222222222222222", username: "bob" });
    const member: any = {
      id: user.id,
      user,
      guild,
      voice: { setChannel: vi.fn(async () => {}) },
    };
    const trigger = makeChannel("trigger-9", "+ New VC");
    guild.channels.cache.set(trigger.id, trigger);

    // Stub guild.channels.create so we can observe the new VC creation.
    const newVc: any = {
      id: "newvc-1",
      name: "bob's VC",
      type: ChannelType.GuildVoice,
      delete: vi.fn(async () => {}),
    };
    guild.channels.create = vi.fn(async () => newVc);

    const oldState = makeState({ channel: null, member, guild });
    const newState = makeState({ channel: trigger, member, guild });

    await execute(oldState, newState);

    // guild.channels.create was called for the new personal VC.
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    const createArg = guild.channels.create.mock.calls[0][0];
    expect(createArg.type).toBe(ChannelType.GuildVoice);
    expect(applyVcTemplate).toHaveBeenCalled();

    // Member is moved into the freshly-created VC.
    expect(member.voice.setChannel).toHaveBeenCalledWith(newVc);

    // State commit: tempChannels owner mapping + persistence row.
    expect(tempvc.tempChannels.get(newVc.id)).toBe(user.id);
    expect(saveTempVc).toHaveBeenCalledWith(
      newVc.id,
      expect.objectContaining({ ownerId: user.id, guildId: guild.id }),
    );

    // Voice log is suppressed for the trigger channel — handler short-circuits
    // the join log so members don't see the noisy "joined +New VC" entry.
    expect(sendModLog).not.toHaveBeenCalled();
  });

  it("create-VC: if the joining user already owns a temp VC, moves them back instead of creating another", async () => {
    const guild = makeGuild({
      settings: { create_vc_channel_id: "trigger-9" },
    });
    const user = makeUser({ id: "333333333333333333", username: "carol" });
    const member: any = {
      id: user.id,
      user,
      guild,
      voice: { setChannel: vi.fn(async () => {}) },
    };
    const trigger = makeChannel("trigger-9", "+ New VC");
    const existing = makeChannel("existing-vc", "carol's VC", { members: [] });
    guild.channels.cache.set(trigger.id, trigger);
    guild.channels.cache.set(existing.id, existing);
    tempvc.tempChannels.set(existing.id, user.id);
    guild.channels.create = vi.fn();

    const oldState = makeState({ channel: null, member, guild });
    const newState = makeState({ channel: trigger, member, guild });

    await execute(oldState, newState);

    // Should NOT create a new channel — should move the user back into their existing one.
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(member.voice.setChannel).toHaveBeenCalledWith(existing, "Prevent duplicate VC");
  });

  it("create-VC: ignores duplicate trigger events while channel creation is in flight", async () => {
    const guild = makeGuild({
      settings: { create_vc_channel_id: "trigger-9" },
    });
    const user = makeUser({ id: "444444444444444444", username: "dana" });
    const member: any = {
      id: user.id,
      user,
      guild,
      voice: { setChannel: vi.fn(async () => {}) },
    };
    const trigger = makeChannel("trigger-9", "+ New VC");
    guild.channels.cache.set(trigger.id, trigger);

    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      guild.channels.create = vi.fn(async () => {
        resolve();
        await new Promise<void>((release) => { releaseCreate = release; });
        return {
          id: "newvc-2",
          name: "dana's VC",
          type: ChannelType.GuildVoice,
          delete: vi.fn(async () => {}),
        };
      });
    });

    const oldState = makeState({ channel: null, member, guild });
    const newState = makeState({ channel: trigger, member, guild });

    const first = execute(oldState, newState);
    await createStarted;
    await execute(oldState, newState);
    releaseCreate();
    await first;

    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(member.voice.setChannel).toHaveBeenCalledTimes(1);
    expect(createControlPanel).toHaveBeenCalledTimes(1);
    expect(tempvc.pendingCreateVcUsers.size).toBe(0);
  });

  it("queues a rename + refreshes the control panel when a member joins a temp VC", async () => {
    const guild = makeGuild();
    const user = makeUser();
    const member: any = { id: user.id, user, guild };

    const tempVc: any = makeChannel("temp-2", "shared VC", { members: [member] });
    guild.channels.cache.set(tempVc.id, tempVc);
    tempvc.tempChannels.set(tempVc.id, "some-other-owner");
    tempvc.tempVcMembers.set(tempVc.id, new Set());

    const oldState = makeState({ channel: null, member, guild });
    const newState = makeState({ channel: tempVc, member, guild });

    await execute(oldState, newState);

    expect(queueRename).toHaveBeenCalledWith(tempVc, guild);
    expect(updateControlPanel).toHaveBeenCalledWith(tempVc.id, guild);
    // Member is tracked in the VC's history set.
    expect(tempvc.tempVcMembers.get(tempVc.id)?.has(user.id)).toBe(true);
  });
});
