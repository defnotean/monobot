import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as loop from "../../../commands/music/loop.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/loop", () => {
  it("refuses when nothing is playing", async () => {
    getQueue.mockReturnValue(null);
    const interaction = makeInteraction({ options: { mode: "track" } });
    await loop.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("track mode sets looping and clears loopingQueue", async () => {
    const queue: any = { playing: true, songs: [{ title: "A" }], looping: false, loopingQueue: true };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ options: { mode: "track" } });
    await loop.execute(interaction);
    expect(queue.looping).toBe(true);
    expect(queue.loopingQueue).toBe(false);
    expect(repliedText(interaction)).toMatch(/Looping current track/i);
  });

  it("queue mode sets loopingQueue and clears looping", async () => {
    const queue: any = { playing: true, songs: [{ title: "A" }], looping: true, loopingQueue: false };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ options: { mode: "queue" } });
    await loop.execute(interaction);
    expect(queue.looping).toBe(false);
    expect(queue.loopingQueue).toBe(true);
    expect(repliedText(interaction)).toMatch(/Looping entire queue/i);
  });

  it("off mode disables both loop flags", async () => {
    const queue: any = { playing: true, songs: [{ title: "A" }], looping: true, loopingQueue: true };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ options: { mode: "off" } });
    await loop.execute(interaction);
    expect(queue.looping).toBe(false);
    expect(queue.loopingQueue).toBe(false);
    expect(repliedText(interaction)).toMatch(/Loop disabled/i);
  });
});
