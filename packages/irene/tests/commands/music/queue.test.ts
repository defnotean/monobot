import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));
// queue.js delegates multi-song rendering to paginate(); mock it so we can
// assert what it would render via the supplied formatPage callback.
vi.mock("../../../utils/pagination.js", () => ({
  paginate: vi.fn(),
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as pagination from "../../../utils/pagination.js";
import * as queueCmd from "../../../commands/music/queue.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
const paginate = pagination.paginate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/queue", () => {
  it("reports an empty queue when none exists", async () => {
    getQueue.mockReturnValue(null);
    const interaction = makeInteraction({});
    await queueCmd.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Empty Queue/i);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("reports an empty queue when the song list is empty", async () => {
    getQueue.mockReturnValue({ songs: [] });
    const interaction = makeInteraction({});
    await queueCmd.execute(interaction);
    expect(repliedText(interaction)).toMatch(/queue is empty/i);
  });

  it("renders a single-song queue inline (no pagination) with now-playing + status", async () => {
    getQueue.mockReturnValue({
      songs: [{ title: "Solo", url: "http://x/s", duration: "2:00", requestedBy: "<@1>" }],
      volume: 90,
      looping: true,
    });
    const interaction = makeInteraction({});
    await queueCmd.execute(interaction);
    expect(paginate).not.toHaveBeenCalled();
    const text = repliedText(interaction);
    expect(text).toContain("Solo");
    expect(text).toContain("90%");
    // single-song header
    expect(text).toMatch(/Queue — 1 song/);
    // track-loop status flag appears
    expect(text).toContain("Track Loop");
  });

  it("delegates to paginate for multi-song queues and the formatPage shows upcoming items", async () => {
    const songs = Array.from({ length: 5 }, (_, i) => ({ title: `Track ${i}`, url: `http://x/${i}` }));
    getQueue.mockReturnValue({ songs, volume: 50 });
    const interaction = makeInteraction({});
    await queueCmd.execute(interaction);

    expect(paginate).toHaveBeenCalledTimes(1);
    const [passedInteraction, opts] = paginate.mock.calls[0] as [any, any];
    expect(passedInteraction).toBe(interaction);
    // upcoming = everything after the current song (4 items)
    expect(opts.items).toHaveLength(4);
    expect(opts.itemsPerPage).toBe(10);

    // Exercise the formatPage callback the way paginate would.
    const embed: any = opts.formatPage(opts.items, 0, 1);
    const data = embed?.data ?? embed;
    expect(data.title).toContain("5 songs");
    const fieldText = JSON.stringify(data.fields ?? []);
    // current (Track 0) is in the Now Playing field; Track 1 is up next.
    expect(fieldText).toContain("Track 0");
    expect(fieldText).toContain("Track 1");
  });
});
