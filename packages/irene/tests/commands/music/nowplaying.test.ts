import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as nowplaying from "../../../commands/music/nowplaying.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/nowplaying", () => {
  it("refuses when there is no queue", async () => {
    getQueue.mockReturnValue(null);
    const interaction = makeInteraction({});
    await nowplaying.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("refuses when the queue has no songs", async () => {
    getQueue.mockReturnValue({ songs: [], playing: true });
    const interaction = makeInteraction({});
    await nowplaying.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("refuses when the queue is not currently playing", async () => {
    getQueue.mockReturnValue({ songs: [{ title: "A" }], playing: false });
    const interaction = makeInteraction({});
    await nowplaying.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("shows the current song with title, requester, volume and loop status", async () => {
    getQueue.mockReturnValue({
      playing: true,
      volume: 80,
      looping: true,
      loopingQueue: false,
      songStartedAt: Date.now() - 30_000,
      songs: [{ title: "Song One", url: "http://x/1", duration: "3:21", requestedBy: "<@123>" }],
    });
    const interaction = makeInteraction({});
    await nowplaying.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("Song One");
    expect(text).toContain("<@123>");
    expect(text).toContain("80%");
    // single-track loop status label
    expect(text).toContain("Track");
  });

  it("renders a LIVE indicator when duration cannot be parsed", async () => {
    getQueue.mockReturnValue({
      playing: true,
      volume: 50,
      songs: [{ title: "Live Stream", url: "http://x/2" }],
    });
    const interaction = makeInteraction({});
    await nowplaying.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toContain("LIVE");
    // requester falls back to "Unknown" when missing
    expect(text).toContain("Unknown");
  });

  it("labels the loop field 'Queue' when loopingQueue is set", async () => {
    getQueue.mockReturnValue({
      playing: true,
      volume: 60,
      looping: false,
      loopingQueue: true,
      songs: [{ title: "Q", url: "http://x/3" }],
    });
    const interaction = makeInteraction({});
    await nowplaying.execute(interaction);
    expect(repliedText(interaction)).toContain("Queue");
  });
});
