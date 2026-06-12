import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as volume from "../../../commands/music/volume.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
// The DJ/same-VC guard now fronts /volume; an Administrator bypasses it, so
// these behavior tests build an admin interaction (the guard itself is
// exercised separately in djGuardedCommands.test.ts).
const adminI = (o = {}) => makeInteraction({ permissions: [PermissionFlagsBits.Administrator], ...o });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/volume", () => {
  it("refuses when there is no queue", async () => {
    getQueue.mockReturnValue(null);
    const interaction = adminI({ options: { level: 50 } });
    await volume.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("sets queue.volume and updates the Lavalink player volume", async () => {
    const setGlobalVolume = vi.fn();
    const queue: any = { songs: [{ title: "Hit" }], player: { setGlobalVolume } };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({ options: { level: 70 } });
    await volume.execute(interaction);
    expect(queue.volume).toBe(70);
    expect(setGlobalVolume).toHaveBeenCalledWith(70);
    const text = repliedText(interaction);
    expect(text).toContain("70%");
    expect(text).toContain("Hit");
  });

  it("works without a Lavalink player attached (no setGlobalVolume call)", async () => {
    const queue: any = { songs: [{ title: "NoPlayer" }], player: null };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({ options: { level: 25 } });
    await volume.execute(interaction);
    expect(queue.volume).toBe(25);
    expect(repliedText(interaction)).toContain("25%");
  });

  it("renders a 10-segment progress bar proportional to the level", async () => {
    const queue: any = { songs: [{ title: "Full" }], player: { setGlobalVolume: vi.fn() } };
    getQueue.mockReturnValue(queue);
    const interaction = adminI({ options: { level: 100 } });
    await volume.execute(interaction);
    const text = repliedText(interaction);
    // 100% => 10 filled blocks, 0 empty
    expect(text).toContain("█".repeat(10));
    expect(text).not.toContain("░");
  });
});
