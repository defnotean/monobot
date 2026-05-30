import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../music/player.js", () => ({
  getQueue: vi.fn(),
}));
vi.mock("../../../ai/karaoke.js", () => ({
  startKaraoke: vi.fn(),
  stopKaraoke: vi.fn(),
  setOffset: vi.fn(),
  getStatus: vi.fn(),
  enableAutoMode: vi.fn(),
}));

// @ts-expect-error JS helper without types
import { makeInteraction, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as player from "../../../music/player.js";
import * as karaokeAi from "../../../ai/karaoke.js";
import * as karaoke from "../../../commands/music/karaoke.js";

const getQueue = player.getQueue as unknown as ReturnType<typeof vi.fn>;
const startKaraoke = karaokeAi.startKaraoke as unknown as ReturnType<typeof vi.fn>;
const stopKaraoke = karaokeAi.stopKaraoke as unknown as ReturnType<typeof vi.fn>;
const setOffset = karaokeAi.setOffset as unknown as ReturnType<typeof vi.fn>;
const getStatus = karaokeAi.getStatus as unknown as ReturnType<typeof vi.fn>;
const enableAutoMode = karaokeAi.enableAutoMode as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/karaoke", () => {
  it("only works in guilds", async () => {
    const interaction = makeInteraction({ subcommand: "status" });
    // makeInteraction always synthesizes a guild; force the DM case the
    // command guards against by nulling it out.
    interaction.guild = null;
    await karaoke.execute(interaction);
    expect(repliedText(interaction)).toMatch(/only works in servers/i);
  });

  describe("start", () => {
    it("uses the explicit song + artist and starts karaoke", async () => {
      startKaraoke.mockResolvedValue({ ok: true, trackName: "Title", artistName: "Artist", lineCount: 12 });
      const interaction = makeInteraction({
        subcommand: "start",
        options: { song: "Title", artist: "Artist", mode: "message" },
      });
      await karaoke.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(startKaraoke).toHaveBeenCalledTimes(1);
      const passed = startKaraoke.mock.calls[0][2];
      expect(passed).toMatchObject({ trackName: "Title", artistName: "Artist", mode: "message" });
      expect(repliedText(interaction)).toMatch(/Lyrics started/i);
    });

    it("falls back to the now-playing track's title + artist when no song is provided", async () => {
      // current.artist is set, so song = current.title and artist = current.artist.
      getQueue.mockReturnValue({ songs: [{ title: "Track Title", artist: "Band Name" }] });
      startKaraoke.mockResolvedValue({ ok: true, trackName: "Track Title", artistName: "Band Name", lineCount: 5 });
      const interaction = makeInteraction({ subcommand: "start", options: {} });
      await karaoke.execute(interaction);
      const passed = startKaraoke.mock.calls[0][2];
      expect(passed.trackName).toBe("Track Title");
      expect(passed.artistName).toBe("Band Name");
      expect(passed.requesterId).toBe(interaction.user.id);
    });

    it("infers artist from a 'Artist - Song' title when current.artist is absent", async () => {
      // No current.artist: artist = title.split(" - ")[0]; song = remainder.
      getQueue.mockReturnValue({ songs: [{ title: "The Artist - The Song" }] });
      startKaraoke.mockResolvedValue({ ok: true, trackName: "The Song", artistName: "The Artist", lineCount: 3 });
      const interaction = makeInteraction({ subcommand: "start", options: {} });
      await karaoke.execute(interaction);
      const passed = startKaraoke.mock.calls[0][2] as any;
      expect(passed.artistName).toBe("The Artist");
      expect(passed.trackName).toBe("The Song");
    });

    it("errors when nothing is playing and no song was given", async () => {
      getQueue.mockReturnValue({ songs: [] });
      const interaction = makeInteraction({ subcommand: "start", options: {} });
      await karaoke.execute(interaction);
      expect(startKaraoke).not.toHaveBeenCalled();
      expect(repliedText(interaction)).toMatch(/nothing is playing/i);
    });

    it("requires an artist when a bare song name is given", async () => {
      // song present but no artist & no current track to infer from
      getQueue.mockReturnValue(undefined);
      const interaction = makeInteraction({ subcommand: "start", options: { song: "Just A Title" } });
      await karaoke.execute(interaction);
      expect(startKaraoke).not.toHaveBeenCalled();
      expect(repliedText(interaction)).toMatch(/provide an artist/i);
    });

    it("surfaces the reason when startKaraoke fails", async () => {
      startKaraoke.mockResolvedValue({ ok: false, reason: "no lyrics found" });
      const interaction = makeInteraction({ subcommand: "start", options: { song: "S", artist: "A" } });
      await karaoke.execute(interaction);
      expect(repliedText(interaction)).toMatch(/couldn't start karaoke/i);
      expect(repliedText(interaction)).toContain("no lyrics found");
    });
  });

  describe("auto", () => {
    it("enables auto mode and confirms", async () => {
      enableAutoMode.mockResolvedValue({ ok: true });
      const interaction = makeInteraction({ subcommand: "auto", options: { mode: "nickname" } });
      await karaoke.execute(interaction);
      expect(enableAutoMode).toHaveBeenCalledTimes(1);
      const [, , userId, opts] = enableAutoMode.mock.calls[0];
      expect(userId).toBe(interaction.user.id);
      expect(opts.mode).toBe("nickname");
      expect(repliedText(interaction)).toMatch(/auto lyrics on/i);
    });

    it("surfaces the failure reason from enableAutoMode", async () => {
      enableAutoMode.mockResolvedValue({ ok: false, reason: "missing perms" });
      const interaction = makeInteraction({ subcommand: "auto", options: {} });
      await karaoke.execute(interaction);
      expect(repliedText(interaction)).toMatch(/couldn't enable auto lyrics/i);
      expect(repliedText(interaction)).toContain("missing perms");
    });
  });

  describe("stop", () => {
    it("stops lyrics on success", async () => {
      stopKaraoke.mockResolvedValue({ ok: true });
      const interaction = makeInteraction({ subcommand: "stop" });
      await karaoke.execute(interaction);
      expect(stopKaraoke).toHaveBeenCalledWith(interaction.guild.id, "manual stop");
      expect(repliedText(interaction)).toMatch(/lyrics stopped/i);
    });

    it("replies with the reason when stop fails", async () => {
      stopKaraoke.mockResolvedValue({ ok: false, reason: "nothing running" });
      const interaction = makeInteraction({ subcommand: "stop" });
      await karaoke.execute(interaction);
      expect(repliedText(interaction)).toContain("nothing running");
    });
  });

  describe("offset", () => {
    it("converts seconds to ms and reports the new total offset", async () => {
      setOffset.mockReturnValue({ ok: true, totalOffsetMs: 1500 });
      const interaction = makeInteraction({ subcommand: "offset", options: { seconds: 1.5 } });
      await karaoke.execute(interaction);
      expect(setOffset).toHaveBeenCalledWith(interaction.guild.id, 1500);
      const text = repliedText(interaction);
      expect(text).toContain("+1.5s");
      expect(text).toContain("1.5s");
    });

    it("replies with the reason when setOffset fails", async () => {
      setOffset.mockReturnValue({ ok: false, reason: "no session" });
      const interaction = makeInteraction({ subcommand: "offset", options: { seconds: -2 } });
      await karaoke.execute(interaction);
      expect(repliedText(interaction)).toContain("no session");
    });
  });

  describe("status", () => {
    it("renders the running session details", async () => {
      getStatus.mockReturnValue({
        trackName: "Track",
        artistName: "Band",
        elapsedMs: 65_000,
        displayMode: "message",
        offsetMs: 0,
        lineCount: 20,
        autoMode: true,
        currentLine: "a line",
      });
      const interaction = makeInteraction({ subcommand: "status" });
      await karaoke.execute(interaction);
      const text = repliedText(interaction);
      expect(text).toContain("Track");
      expect(text).toContain("Band");
      // 65000ms => 1:05
      expect(text).toContain("1:05");
      expect(text).toMatch(/Auto:/);
    });

    it("reports no session when none is running", async () => {
      getStatus.mockReturnValue(null);
      const interaction = makeInteraction({ subcommand: "status" });
      await karaoke.execute(interaction);
      expect(repliedText(interaction)).toMatch(/no lyrics running/i);
    });
  });
});
