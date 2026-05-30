// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const listenerState = { active: false, wake: "irene" };

vi.mock("../../../voice/listener.js", () => ({
  startListening: vi.fn(async () => ({ success: true })),
  stopListening: vi.fn(),
  isListening: vi.fn(() => listenerState.active),
  getWakeWord: vi.fn(() => listenerState.wake),
  setWakeWord: vi.fn((g, w) => {
    listenerState.wake = w;
  }),
}));

vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  startListening,
  stopListening,
  isListening,
  setWakeWord,
} from "../../../voice/listener.js";
import { execute, data } from "../../../commands/ai/listen.js";
// @ts-expect-error JS helper, no types
import {
  makeInteraction,
  makeChannel,
  makeMember,
  makeUser,
  makeGuild,
  repliedText,
  lastReply,
} from "../../_helpers/mockDiscord.js";

// A voice channel that the bot has full perms in by default.
function voiceChannel({ canConnect = true } = {}) {
  const ch = makeChannel({ name: "Voice", type: 2 });
  ch.permissionsFor = vi.fn(() => ({ has: (p) => (canConnect ? true : false) }));
  return ch;
}

beforeEach(() => {
  vi.clearAllMocks();
  listenerState.active = false;
  listenerState.wake = "irene";
});

describe("/listen", () => {
  it("declares the listen command", () => {
    expect(data.name).toBe("listen");
  });

  it("start: errors when the user isn't in a VC and no channel given", async () => {
    const user = makeUser();
    const guild = makeGuild();
    const member = makeMember({ user, guild }); // voice.channel = null
    const interaction = makeInteraction({
      guild,
      user,
      member,
      subcommand: "start",
      options: {},
    });
    await execute(interaction);
    expect(startListening).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/not in a voice channel/i);
  });

  it("start: errors when already listening", async () => {
    listenerState.active = true;
    const vc = voiceChannel();
    const interaction = makeInteraction({
      subcommand: "start",
      options: { channel: vc },
    });
    await execute(interaction);
    expect(startListening).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/already listening/i);
  });

  it("start: errors when the bot lacks Connect/Speak in the channel", async () => {
    const vc = voiceChannel({ canConnect: false });
    const interaction = makeInteraction({
      subcommand: "start",
      options: { channel: vc },
    });
    await execute(interaction);
    expect(startListening).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/can't join that channel/i);
  });

  it("start: defers and starts listening when perms pass", async () => {
    const vc = voiceChannel();
    const interaction = makeInteraction({
      subcommand: "start",
      options: { channel: vc },
    });
    await execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(startListening).toHaveBeenCalledTimes(1);
    expect(repliedText(interaction)).toMatch(/listening started/i);
  });

  it("start: reports the failure when startListening fails", async () => {
    startListening.mockResolvedValueOnce({ success: false, error: "connect timed out" });
    const vc = voiceChannel();
    const interaction = makeInteraction({
      subcommand: "start",
      options: { channel: vc },
    });
    await execute(interaction);
    expect(repliedText(interaction)).toMatch(/failed to start listening/i);
    expect(repliedText(interaction)).toContain("connect timed out");
  });

  it("stop: errors when not listening", async () => {
    listenerState.active = false;
    const interaction = makeInteraction({ subcommand: "stop", options: {} });
    await execute(interaction);
    expect(stopListening).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/not listening/i);
  });

  it("stop: stops when active", async () => {
    listenerState.active = true;
    const interaction = makeInteraction({ subcommand: "stop", options: {} });
    await execute(interaction);
    expect(stopListening).toHaveBeenCalledWith(interaction.guildId);
    expect(repliedText(interaction)).toMatch(/listening stopped/i);
  });

  it("status: shows active vs inactive states", async () => {
    listenerState.active = true;
    const a = makeInteraction({ subcommand: "status", options: {} });
    await execute(a);
    expect(repliedText(a)).toMatch(/Listening Active/i);

    listenerState.active = false;
    const b = makeInteraction({ subcommand: "status", options: {} });
    await execute(b);
    expect(repliedText(b)).toMatch(/not listening/i);
  });

  it("wakeword: rejects invalid characters", async () => {
    const interaction = makeInteraction({
      subcommand: "wakeword",
      options: { word: "bad!!word" },
    });
    await execute(interaction);
    expect(setWakeWord).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toMatch(/invalid wake word/i);
  });

  it("wakeword: lowercases/trims and saves a valid word", async () => {
    const interaction = makeInteraction({
      subcommand: "wakeword",
      options: { word: "  Hey Bot  " },
    });
    await execute(interaction);
    expect(setWakeWord).toHaveBeenCalledWith(interaction.guildId, "hey bot");
    expect(repliedText(interaction)).toMatch(/wake word updated/i);
  });
});
