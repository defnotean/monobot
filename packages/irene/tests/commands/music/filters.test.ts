import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as filters from "../../../commands/music/filters.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/filter list", () => {
  it("lists every available filter without needing playback", async () => {
    const interaction = makeInteraction({ subcommand: "list" });
    await filters.execute(interaction);
    const text = repliedText(interaction);
    expect(text).toMatch(/Available Filters/i);
    expect(text).toContain("bassboost");
    expect(text).toContain("nightcore");
    expect(getQueue).not.toHaveBeenCalled();
  });
});

describe("/filter apply", () => {
  it("refuses when nothing is playing", async () => {
    getQueue.mockReturnValue(null);
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "bassboost" } });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });

  it("refuses an unknown filter name", async () => {
    getQueue.mockReturnValue({ playing: true, player: { setFilters: vi.fn() } });
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "does-not-exist" } });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Filter Not Found/i);
  });

  it("reports a disconnected player", async () => {
    getQueue.mockReturnValue({ playing: true, player: null, songs: [{ title: "A" }] });
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "bassboost" } });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Not Connected/i);
  });

  it("applies a known equalizer filter and records the active filter", async () => {
    const setFilters = vi.fn();
    const queue: any = { playing: true, player: { setFilters }, songs: [{ title: "Tune" }] };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "bassboost" } });
    await filters.execute(interaction);

    expect(setFilters).toHaveBeenCalledTimes(1);
    expect(setFilters.mock.calls[0][0]).toHaveProperty("equalizer");
    expect(queue.activeFilter).toBe("bassboost");
    const text = repliedText(interaction);
    expect(text).toMatch(/Filter Applied/i);
    // NOTE: musicEmbed("Filter Applied", "**Bass Boost**") then calls
    // .setDescription(filter.description), which overwrites the title-line, so
    // the embed shows the *description* ("Enhanced bass") and the now-playing
    // track, not the filter's display name. Assert on what actually renders.
    expect(text).toContain("Enhanced bass");
    expect(text).toContain("Tune");
  });

  it("applies a timescale filter (nightcore)", async () => {
    const setFilters = vi.fn();
    const queue: any = { playing: true, player: { setFilters }, songs: [{ title: "X" }] };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "nightcore" } });
    await filters.execute(interaction);
    expect(setFilters.mock.calls[0][0]).toHaveProperty("timescale");
    expect(queue.activeFilter).toBe("nightcore");
  });

  it("warns about a nightcore/vaporwave conflict when switching between them", async () => {
    const setFilters = vi.fn();
    const queue: any = { playing: true, player: { setFilters }, activeFilter: "vaporwave", songs: [{ title: "X" }] };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "nightcore" } });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Conflict Warning/i);
    expect(queue.activeFilter).toBe("nightcore");
  });

  it("surfaces an error embed when setFilters throws", async () => {
    const setFilters = vi.fn(() => { throw new Error("lavalink down"); });
    getQueue.mockReturnValue({ playing: true, player: { setFilters }, songs: [{ title: "X" }] });
    const interaction = makeInteraction({ subcommand: "apply", options: { name: "8d" } });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Filter Error/i);
    expect(repliedText(interaction)).toContain("lavalink down");
  });
});

describe("/filter current", () => {
  it("reports no active filter (does not require playback)", async () => {
    getQueue.mockReturnValue({ activeFilter: null });
    const interaction = makeInteraction({ subcommand: "current" });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/No filters are currently active/i);
  });

  it("shows the active filter when one is set", async () => {
    getQueue.mockReturnValue({ activeFilter: "vaporwave" });
    const interaction = makeInteraction({ subcommand: "current" });
    await filters.execute(interaction);
    // Same overwrite quirk as apply: the rendered text is the filter's
    // description ("Slowed and lo-fi effect"), not its display name.
    expect(repliedText(interaction)).toContain("Slowed and lo-fi effect");
  });
});

describe("/filter reset", () => {
  it("requires playback and clears all filters", async () => {
    const setFilters = vi.fn();
    const queue: any = { playing: true, player: { setFilters }, activeFilter: "bassboost" };
    getQueue.mockReturnValue(queue);
    const interaction = makeInteraction({ subcommand: "reset" });
    await filters.execute(interaction);
    expect(setFilters).toHaveBeenCalledTimes(1);
    // empties the equalizer in the cleared config
    expect(setFilters.mock.calls[0][0]).toMatchObject({ equalizer: [] });
    expect(queue.activeFilter).toBeNull();
    expect(repliedText(interaction)).toMatch(/Filters Reset/i);
  });

  it("refuses reset when nothing is playing", async () => {
    getQueue.mockReturnValue(null);
    const interaction = makeInteraction({ subcommand: "reset" });
    await filters.execute(interaction);
    expect(repliedText(interaction)).toMatch(/Nothing Playing/i);
  });
});
