import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as resume from "../../../commands/music/resume.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
// The DJ/same-VC guard now fronts /resume; an Administrator bypasses it, so
// these behavior tests build an admin interaction (the guard itself is
// exercised separately in djGuardedCommands.test.ts).
const adminI = (o = {}) => makeInteraction({ permissions: [PermissionFlagsBits.Administrator], ...o });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/resume", () => {
  it("refuses when there is no queue", async () => {
    getQueue.mockReturnValue(null);
    const interaction = adminI({});
    await resume.execute(interaction);
    expect(getQueue).toHaveBeenCalledWith(interaction.guild.id);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("reports empty when not playing and queue has no songs", async () => {
    getQueue.mockReturnValue({ playing: false, songs: [], player: { paused: true } });
    const interaction = adminI({});
    await resume.execute(interaction);
    expect(repliedText(interaction)).toMatch(/nothing to resume/i);
  });

  it("rejects when the player is not paused", async () => {
    const setPaused = vi.fn();
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "A" }], player: { paused: false, setPaused } });
    const interaction = adminI({});
    await resume.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not Paused/i);
    expect(setPaused).not.toHaveBeenCalled();
  });

  it("resumes a paused player and confirms with the track title", async () => {
    const setPaused = vi.fn();
    getQueue.mockReturnValue({ playing: true, songs: [{ title: "Track Z" }], player: { paused: true, setPaused } });
    const interaction = adminI({});
    await resume.execute(interaction);
    expect(setPaused).toHaveBeenCalledWith(false);
    const text = repliedText(interaction);
    expect(text).toMatch(/Resumed/i);
    expect(text).toContain("Track Z");
  });
});
