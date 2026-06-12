import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as loop from "../../../commands/music/loop.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
// The DJ/same-VC guard now fronts /loop; an Administrator bypasses it, so
// these behavior tests build an admin interaction (the guard itself is
// exercised separately in djGuardedCommands.test.ts).
const adminI = (o = {}) => makeInteraction({ permissions: [PermissionFlagsBits.Administrator], ...o });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/loop", () => {
  it("refuses when nothing is playing", async () => {
    getQueue.mockReturnValue(null);
    const interaction = adminI({ options: { mode: "track" } });
    await loop.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("track mode sets looping and clears loopingQueue", async () => {
    const queue: any = { playing: true, songs: [{ title: "A" }], looping: false, loopingQueue: true };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({ options: { mode: "track" } });
    await loop.execute(interaction);
    expect(queue.looping).toBe(true);
    expect(queue.loopingQueue).toBe(false);
    expect(repliedText(interaction)).toMatch(/Looping current track/i);
  });

  it("queue mode sets loopingQueue and clears looping", async () => {
    const queue: any = { playing: true, songs: [{ title: "A" }], looping: true, loopingQueue: false };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({ options: { mode: "queue" } });
    await loop.execute(interaction);
    expect(queue.looping).toBe(false);
    expect(queue.loopingQueue).toBe(true);
    expect(repliedText(interaction)).toMatch(/Looping entire queue/i);
  });

  it("off mode disables both loop flags", async () => {
    const queue: any = { playing: true, songs: [{ title: "A" }], looping: true, loopingQueue: true };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({ options: { mode: "off" } });
    await loop.execute(interaction);
    expect(queue.looping).toBe(false);
    expect(queue.loopingQueue).toBe(false);
    expect(repliedText(interaction)).toMatch(/Loop disabled/i);
  });
});
