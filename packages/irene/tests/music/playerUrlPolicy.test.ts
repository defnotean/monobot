import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));
const safeFetch = vi.hoisted(() => vi.fn(async () => ({ text: "<title>Safe Song | Spotify</title>" })));
vi.mock("@defnotean/shared/safeFetch", () => ({ safeFetch }));

import {
  assertAllowedMusicUrl,
  createQueue,
  deleteQueue,
  initMusic,
  isAllowedMusicUrl,
  isSpotifyHost,
  parseAllowedMusicUrl,
  playSong,
  playSoundEffect,
  searchPlaylist,
  searchSong,
} from "../../music/player.js";

function installShoukaku(resolve = vi.fn()) {
  const node = { rest: { resolve } };
  initMusic({
    nodes: new Map([["node", node]]),
    joinVoiceChannel: vi.fn(async () => ({
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      playTrack: vi.fn(),
      setGlobalVolume: vi.fn(),
    })),
  } as any);
  return resolve;
}

describe("music URL provider policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects arbitrary HTTP(S) URLs before Lavalink resolve", async () => {
    const resolve = installShoukaku(vi.fn());

    await expect(searchSong("https://example.com/audio.mp3")).resolves.toBeNull();
    await expect(searchPlaylist("https://example.com/playlist?list=spotify.com")).resolves.toBeNull();

    expect(resolve).not.toHaveBeenCalled();
  });

  it("allows supported provider URLs", () => {
    expect(isAllowedMusicUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isAllowedMusicUrl("https://youtu.be/abc")).toBe(true);
    expect(isAllowedMusicUrl("https://music.youtube.com/watch?v=abc")).toBe(true);
    expect(isAllowedMusicUrl("https://open.spotify.com/track/abc?si=tracking")).toBe(true);
    expect(isAllowedMusicUrl("https://soundcloud.com/artist/track")).toBe(true);
  });

  it("rejects substring host bypasses", () => {
    expect(parseAllowedMusicUrl("https://evil.com/youtube.com/watch?v=abc")).toBeNull();
    expect(parseAllowedMusicUrl("https://youtube.com.evil.com/watch?v=abc")).toBeNull();
    expect(parseAllowedMusicUrl("https://spotify.com.evil.com/track/abc")).toBeNull();
    expect(parseAllowedMusicUrl("https://notspotify.com/track/abc")).toBeNull();
    expect(parseAllowedMusicUrl("https://soundcloud.com.evil.com/artist/track")).toBeNull();
    expect(parseAllowedMusicUrl("https://on.soundcloud.com.evil.com/abc")).toBeNull();
    expect(isSpotifyHost("https://evil.com/spotify.com")).toBe(false);
    expect(isSpotifyHost("https://spotify.com.evil.com/track")).toBe(false);
  });

  it("normalizes Spotify tracking parameters before resolve/fallback use", () => {
    expect(assertAllowedMusicUrl("https://open.spotify.com/track/abc?si=tracking#frag"))
      .toBe("https://open.spotify.com/track/abc");
  });

  it("runs the Spotify HTML fallback only after parsed-host validation", async () => {
    const resolve = installShoukaku(vi.fn()
      .mockResolvedValueOnce({ loadType: "empty" })
      .mockResolvedValueOnce({
        loadType: "search",
        data: [{ encoded: "track", info: { title: "Safe Song", author: "Artist", uri: "https://www.youtube.com/watch?v=safe", length: 123000 } }],
      }));

    const song = await searchSong("https://open.spotify.com/track/abc?si=tracking");

    expect(safeFetch).toHaveBeenCalledWith("https://open.spotify.com/track/abc");
    expect(resolve).toHaveBeenNthCalledWith(1, "https://open.spotify.com/track/abc");
    expect(resolve).toHaveBeenNthCalledWith(2, "ytsearch:Safe Song audio");
    expect(song?.title).toBe("Safe Song");
  });

  it("keeps soundboard playback from resolving stored arbitrary URLs", async () => {
    const resolve = installShoukaku(vi.fn());

    await expect(playSoundEffect("guild-sfx", "https://example.com/sfx.mp3", { id: "vc" } as any))
      .rejects.toThrow(/Only YouTube, Spotify, and SoundCloud/i);

    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects queued arbitrary HTTP URLs before playSong can resolve them", async () => {
    const resolve = installShoukaku(vi.fn());
    const queue: any = createQueue("guild-queued-url", { id: "vc" } as any, null);
    queue.player = {
      playTrack: vi.fn(),
      setGlobalVolume: vi.fn(),
      removeAllListeners: vi.fn(),
      stopTrack: vi.fn(),
      connection: { disconnect: vi.fn() },
    };
    queue.songs = [{ title: "bad", url: "https://example.com/track.mp3" }];

    await expect(playSong(queue)).rejects.toThrow(/Only YouTube, Spotify, and SoundCloud/i);

    expect(resolve).not.toHaveBeenCalled();
    deleteQueue("guild-queued-url");
  });
});
