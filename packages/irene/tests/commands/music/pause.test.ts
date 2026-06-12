import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText, lastReply, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as pause from "../../../commands/music/pause.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
// The DJ/same-VC guard now fronts /pause; an Administrator bypasses it, so
// these behavior tests build an admin interaction (the guard itself is
// exercised separately in djGuardedCommands.test.ts).
const adminI = (o = {}) => makeInteraction({ permissions: [PermissionFlagsBits.Administrator], ...o });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/pause", () => {
  it("declares the command name", () => {
    expect(pause.data.name).toBe("pause");
  });

  it("refuses when there is no queue", async () => {
    getQueue.mockReturnValue(null);
    const interaction = adminI({});
    await pause.execute(interaction);
    expect(getQueue).toHaveBeenCalledWith(interaction.guild.id);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("refuses when the queue exists but is not playing", async () => {
    getQueue.mockReturnValue({ playing: false, songs: [{ title: "A" }] });
    const interaction = adminI({});
    await pause.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("rejects when already paused and does not toggle the player again", async () => {
    const setPaused = vi.fn();
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "A" }], player: { paused: true, setPaused } });
    const interaction = adminI({});
    await pause.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Already Paused/i);
    expect(setPaused).not.toHaveBeenCalled();
  });

  it("pauses the player and confirms with the current track title", async () => {
    const setPaused = vi.fn();
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "My Song" }], player: { paused: false, setPaused } });
    const interaction = adminI({});
    await pause.execute(interaction);
    expect(setPaused).toHaveBeenCalledWith(true);
    const text = repliedText(interaction);
    expect(text).toMatch(/Paused/i);
    expect(text).toContain("My Song");
  });

  it("pauses even when there is no Lavalink player object (optional chaining)", async () => {
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "X" }], player: null });
    const interaction = adminI({});
    await pause.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Paused/i);
    expect(lastReply(interaction)).toBeTruthy();
  });
});
