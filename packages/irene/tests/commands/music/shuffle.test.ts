import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as shuffle from "../../../commands/music/shuffle.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
// The DJ/same-VC guard now fronts /shuffle; an Administrator bypasses it, so
// these behavior tests build an admin interaction (the guard itself is
// exercised separately in djGuardedCommands.test.ts).
const adminI = (o = {}) => makeInteraction({ permissions: [PermissionFlagsBits.Administrator], ...o });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/shuffle", () => {
  it("refuses when there is no queue", async () => {
    getQueue.mockReturnValue(null);
    const interaction = adminI({});
    await shuffle.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing to Shuffle/i);
  });

  it("refuses when fewer than two songs are queued", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "only" }] });
    const interaction = adminI({});
    await shuffle.execute(interaction);
    expect(repliedText(interaction)).toMatch(/at least 2 songs/i);
  });

  it("keeps the currently-playing song first and shuffles the rest", async () => {
    // Force Math.random to 0 so the Fisher-Yates picks index 0 each step,
    // making the permutation deterministic for assertion.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queue: any = {
      songs: [{ title: "current" }, { title: "b" }, { title: "c" }, { title: "d" }],
      shuffle: false,
    };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({});
    await shuffle.execute(interaction);

    // Current track is never moved out of position 0
    expect(queue.songs[0].title).toBe("current");
    // Still 4 songs total, just reordered
    expect(queue.songs).toHaveLength(4);
    expect(queue.songs.map((s: any) => s.title).sort()).toEqual(["b", "c", "current", "d"].sort());
    // Auto-shuffle toggled on
    expect(queue.shuffle).toBe(true);
    expect(repliedText(interaction)).toMatch(/Reshuffled/i);
  });

  it("toggles auto-shuffle off when it was already on", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queue: any = { songs: [{ title: "a" }, { title: "b" }], shuffle: true };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({});
    await shuffle.execute(interaction);
    expect(queue.shuffle).toBe(false);
    expect(repliedText(interaction)).toMatch(/Off/);
  });
});
