// ─── musicExecutor — Lavalink playback / queue control branches ──────────────
//
// The handler pulls player state from music/player.js via dynamic import. We
// mock that module (and the karaoke module) so we can drive the "no queue",
// "nothing playing", validation, and state-mutation branches deterministically
// without a live Lavalink node. Focus is on the guard/error paths the AI hits
// most: empty queue, NaN volume, unknown filter, missing voice channel.

import { describe, it, expect, vi, beforeEach } from "vitest";

const player = vi.hoisted(() => ({
  getQueue: vi.fn(),
  createQueue: vi.fn(),
  connectToChannel: vi.fn(async () => {}),
  playSong: vi.fn(async () => {}),
  searchSong: vi.fn(),
  searchPlaylist: vi.fn(async () => null),
  deleteQueue: vi.fn(),
}));

const karaoke = vi.hoisted(() => ({
  startKaraoke: vi.fn(),
  stopKaraoke: vi.fn(),
  enableAutoMode: vi.fn(),
}));

vi.mock("../../../music/player.js", () => player);
vi.mock("../../../ai/karaoke.js", () => karaoke);
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));

// @ts-expect-error - importing JS module without types
import { execute } from "../../../ai/executors/musicExecutor.js";
// The DJ + same-VC gate runs the REAL utils/musicGuard.js, which reads the DJ
// role from the real commands/music/dj.js store.
// @ts-expect-error - importing JS module without types
import { setDjRole, removeDjRole } from "../../../commands/music/dj.js";

// Guild fixture rich enough for the DJ + same-VC guard: the bot is connected
// to voice channel "vc1" and the default member (below) shares it.
const BOT_ID = "bot-1";
const guild = {
  id: "guild-1",
  ownerId: "owner-9",
  client: { user: { id: BOT_ID } },
  members: {
    cache: new Map([[BOT_ID, { voice: { channel: { id: "vc1" } } }]]),
    fetch: vi.fn(async () => null),
  },
  roles: { cache: new Map() },
};

function buildMessage({ inVc = true, roleIds = [] as string[] } = {}) {
  return {
    author: { id: "u1", toString: () => "<@u1>" },
    member: {
      id: "u1",
      voice: { channel: inVc ? { id: "vc1" } : null },
      permissions: { has: () => false },
      roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
    },
    channel: { id: "txt1" },
    guild,
    client: {},
  };
}

const ctx = { guild } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("musicExecutor — routing", () => {
  it("returns undefined for an unhandled tool", async () => {
    const r = await execute("not_music", {}, buildMessage(), ctx);
    expect(r).toBeUndefined();
  });
});

describe("play_music", () => {
  it("refuses when the requester isn't in a voice channel", async () => {
    const r = await execute("play_music", { query: "x" }, buildMessage({ inVc: false }), ctx);
    expect(String(r)).toMatch(/voice channel first/i);
    expect(player.searchSong).not.toHaveBeenCalled();
  });

  it("reports no results when nothing is found", async () => {
    player.searchPlaylist.mockResolvedValue(null);
    player.searchSong.mockResolvedValue(null);
    const r = await execute("play_music", { query: "asdfqwer" }, buildMessage(), ctx);
    expect(String(r)).toMatch(/couldn't find anything/i);
  });

  it("creates a queue and plays a found song immediately when the queue was empty", async () => {
    player.searchPlaylist.mockResolvedValue(null);
    player.searchSong.mockResolvedValue({ title: "Song A", duration: "3:00" });
    const queue = { songs: [] as any[] };
    player.getQueue.mockReturnValue(undefined);
    player.createQueue.mockReturnValue(queue);
    const r = await execute("play_music", { query: "song a" }, buildMessage(), ctx);
    expect(player.connectToChannel).toHaveBeenCalled();
    expect(player.playSong).toHaveBeenCalledWith(queue);
    expect(String(r)).toMatch(/now playing \*\*Song A\*\*/);
  });

  it("queues a song behind others without auto-playing", async () => {
    player.searchPlaylist.mockResolvedValue(null);
    player.searchSong.mockResolvedValue({ title: "Song B" });
    const queue = { songs: [{ title: "Now Playing" }] };
    player.getQueue.mockReturnValue(queue);
    const r = await execute("play_music", { query: "song b" }, buildMessage(), ctx);
    expect(player.playSong).not.toHaveBeenCalled();
    expect(String(r)).toMatch(/added \*\*Song B\*\* to the queue at position #2/);
  });

  it("maps a 429 error to a rate-limit message", async () => {
    player.searchPlaylist.mockRejectedValue(new Error("HTTP 429 too many requests"));
    const r = await execute("play_music", { query: "x" }, buildMessage(), ctx);
    expect(String(r)).toMatch(/rate-limiting/i);
  });

  it("maps an age-restriction error to a friendly message", async () => {
    player.searchPlaylist.mockRejectedValue(new Error("Sign in to confirm your age"));
    const r = await execute("play_music", { query: "x" }, buildMessage(), ctx);
    expect(String(r)).toMatch(/age-restricted/i);
  });

  it("queues a whole playlist when one is found", async () => {
    player.searchPlaylist.mockResolvedValue({ name: "My Mix", tracks: [{ title: "t1" }, { title: "t2" }] });
    const queue = { songs: [] as any[] };
    player.getQueue.mockReturnValue(undefined);
    player.createQueue.mockReturnValue(queue);
    const r = await execute("play_music", { query: "my mix" }, buildMessage(), ctx);
    expect(String(r)).toMatch(/queued \*\*2\*\* tracks from \*\*My Mix\*\*/);
    expect(player.playSong).toHaveBeenCalled();
  });
});

describe("skip_song", () => {
  it("reports nothing playing on an empty queue", async () => {
    player.getQueue.mockReturnValue(null);
    const r = await execute("skip_song", {}, buildMessage(), ctx);
    expect(String(r)).toMatch(/nothing is playing/i);
  });

  it("skips the current track and flags _skipOnce", async () => {
    const stopTrack = vi.fn();
    const queue = { songs: [{ title: "Current" }], player: { stopTrack } };
    player.getQueue.mockReturnValue(queue);
    const r = await execute("skip_song", {}, buildMessage(), ctx);
    expect(queue._skipOnce).toBe(true);
    expect(stopTrack).toHaveBeenCalled();
    expect(String(r)).toMatch(/skipped \*\*Current\*\*/);
  });
});

describe("stop_music", () => {
  it("tears down the queue", async () => {
    const r = await execute("stop_music", {}, buildMessage(), ctx);
    expect(player.deleteQueue).toHaveBeenCalledWith("guild-1");
    expect(String(r)).toMatch(/stopped the music/i);
  });
});

describe("set_volume", () => {
  it("rejects a non-numeric / missing volume (NaN guard)", async () => {
    player.getQueue.mockReturnValue({ player: { setGlobalVolume: vi.fn() } });
    const r = await execute("set_volume", {}, buildMessage(), ctx);
    expect(String(r)).toMatch(/give me a volume between 0 and 100/i);
  });

  it("clamps an out-of-range volume to 100", async () => {
    const setGlobalVolume = vi.fn();
    const queue = { player: { setGlobalVolume } };
    player.getQueue.mockReturnValue(queue);
    const r = await execute("set_volume", { volume: 999 }, buildMessage(), ctx);
    expect(setGlobalVolume).toHaveBeenCalledWith(100);
    expect(String(r)).toMatch(/volume set to \*\*100%\*\*/);
  });

  it("reports nothing playing when there is no queue", async () => {
    player.getQueue.mockReturnValue(undefined);
    const r = await execute("set_volume", { volume: 50 }, buildMessage(), ctx);
    expect(String(r)).toMatch(/nothing is playing/i);
  });
});

describe("music_filter", () => {
  it("rejects an unknown filter name and lists the valid ones", async () => {
    player.getQueue.mockReturnValue({ player: { setFilters: vi.fn() } });
    const r = await execute("music_filter", { filter: "explode" }, buildMessage(), ctx);
    expect(String(r)).toMatch(/unknown filter "explode"/i);
    expect(String(r)).toMatch(/bassboost/);
  });

  it("applies a known filter", async () => {
    const setFilters = vi.fn(async () => {});
    player.getQueue.mockReturnValue({ player: { setFilters } });
    const r = await execute("music_filter", { filter: "nightcore" }, buildMessage(), ctx);
    expect(setFilters).toHaveBeenCalled();
    expect(String(r)).toMatch(/\*\*nightcore\*\* filter applied/);
  });

  it("reports nothing playing without a player", async () => {
    player.getQueue.mockReturnValue(null);
    const r = await execute("music_filter", { filter: "none" }, buildMessage(), ctx);
    expect(String(r)).toMatch(/nothing is playing/i);
  });
});

describe("toggle_loop", () => {
  it("sets song-loop mode", async () => {
    const queue: any = {};
    player.getQueue.mockReturnValue(queue);
    const r = await execute("toggle_loop", { mode: "song" }, buildMessage(), ctx);
    expect(queue.looping).toBe(true);
    expect(queue.loopingQueue).toBe(false);
    expect(String(r)).toMatch(/looping current song/i);
  });

  it("disables looping with an unknown mode", async () => {
    const queue: any = { looping: true, loopingQueue: true };
    player.getQueue.mockReturnValue(queue);
    const r = await execute("toggle_loop", { mode: "off" }, buildMessage(), ctx);
    expect(queue.looping).toBe(false);
    expect(queue.loopingQueue).toBe(false);
    expect(String(r)).toMatch(/looping disabled/i);
  });
});

describe("DJ + same-VC gate (AI path)", () => {
  it("blocks skip_song when the requester is not in the bot's voice channel", async () => {
    const stopTrack = vi.fn();
    player.getQueue.mockReturnValue({ songs: [{ title: "Current" }], player: { stopTrack } });
    const r = await execute("skip_song", {}, buildMessage({ inVc: false }), ctx);
    expect(String(r)).toMatch(/same voice channel/i);
    expect(stopTrack).not.toHaveBeenCalled();
  });

  it("blocks stop_music for a non-DJ when a DJ role is set", async () => {
    setDjRole(guild.id, "dj-role-1");
    try {
      const r = await execute("stop_music", {}, buildMessage(), ctx);
      expect(String(r)).toMatch(/only \*\*.+\*\* can use this command/i);
      expect(player.deleteQueue).not.toHaveBeenCalled();
    } finally {
      removeDjRole(guild.id);
    }
  });

  it("allows playback control for a member holding the DJ role", async () => {
    setDjRole(guild.id, "dj-role-1");
    try {
      const r = await execute("stop_music", {}, buildMessage({ roleIds: ["dj-role-1"] }), ctx);
      expect(player.deleteQueue).toHaveBeenCalledWith("guild-1");
      expect(String(r)).toMatch(/stopped the music/i);
    } finally {
      removeDjRole(guild.id);
    }
  });

  it("blocks set_volume from outside the VC before touching the player", async () => {
    const setGlobalVolume = vi.fn();
    player.getQueue.mockReturnValue({ player: { setGlobalVolume } });
    const r = await execute("set_volume", { volume: 50 }, buildMessage({ inVc: false }), ctx);
    expect(String(r)).toMatch(/same voice channel/i);
    expect(setGlobalVolume).not.toHaveBeenCalled();
  });

  it("does not gate read-only tools like music_queue", async () => {
    player.getQueue.mockReturnValue({ songs: [{ title: "Current", duration: "3:00" }] });
    const r = await execute("music_queue", {}, buildMessage({ inVc: false }), ctx);
    expect(String(r)).toMatch(/\*\*Current\*\*/);
  });
});

describe("lyrics mode guards", () => {
  it("start_lyrics_mode refuses outside a guild", async () => {
    const msg = { ...buildMessage(), guild: null };
    const r = await execute("start_lyrics_mode", {}, msg, ctx);
    expect(String(r)).toMatch(/only works in servers/i);
  });

  it("start_lyrics_mode needs a playing track when no song is supplied", async () => {
    player.getQueue.mockReturnValue({ songs: [] });
    const r = await execute("start_lyrics_mode", {}, buildMessage(), ctx);
    expect(String(r)).toMatch(/nothing is playing/i);
  });

  it("start_lyrics_mode succeeds with explicit song + artist", async () => {
    karaoke.startKaraoke.mockResolvedValue({ ok: true, trackName: "Hello", artistName: "Adele", lineCount: 42 });
    const r = await execute("start_lyrics_mode", { song: "Hello", artist: "Adele" }, buildMessage(), ctx);
    expect(karaoke.startKaraoke).toHaveBeenCalled();
    expect(String(r)).toMatch(/lyrics mode on/i);
    expect(String(r)).toContain("Adele");
  });

  it("stop_lyrics_mode reports the karaoke module's result", async () => {
    karaoke.stopKaraoke.mockResolvedValue({ ok: true });
    const r = await execute("stop_lyrics_mode", {}, buildMessage(), ctx);
    expect(String(r)).toMatch(/lyrics mode off/i);
  });
});
