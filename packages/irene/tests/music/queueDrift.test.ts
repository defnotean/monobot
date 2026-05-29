// Regression — Lavalink/queue state-drift guards (resilience task 3).
//
// A Lavalink player can emit a late track-end/exception/stuck event, or a
// queued reconnect can fire, AFTER the queue it belongs to was torn down by
// `stop` (deleteQueue) — or after that guild's queue was replaced by a fresh
// `play`. The old guard (`queues.has(guildId)`) returns true for the
// REPLACEMENT queue, so the stale event/reconnect would operate on the wrong
// (dead or replaced) queue object: shifting songs off it, re-entering
// playSong, and corrupting playback state.
//
// playSong now gates on isQueueLive (object identity + not-destroyed), so a
// call holding a stale queue reference is a no-op. These tests drive that
// through the exported playSong + deleteQueue.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));
// karaoke import is pulled in by player.js; stub the surface playSong touches.
vi.mock("../../ai/karaoke.js", () => ({
  onTrackStart: vi.fn(),
  onTrackEnd: vi.fn(),
  hasSession: () => false,
  extractSongInfo: () => ({ title: "", artist: "" }),
  stopKaraoke: vi.fn(async () => {}),
}));

import { initMusic, createQueue, deleteQueue, getQueue, playSong } from "../../music/player.js";

const GUILD = "guild-drift-test";

// A Lavalink node whose resolve()/the player's playTrack() act as tripwires:
// if the drift guard fails, playSong reaches them and the spies record a call.
function makeShoukaku() {
  const resolve = vi.fn(async () => ({
    loadType: "track",
    data: { encoded: "ENCODED", info: { title: "Song A" } },
  }));
  const node = { rest: { resolve } };
  return {
    _resolve: resolve,
    nodes: new Map([["main", node]]),
  };
}

function makePlayer() {
  return {
    playTrack: vi.fn(async () => {}),
    setGlobalVolume: vi.fn(),
    stopTrack: vi.fn(),
    removeAllListeners: vi.fn(),
    connection: { disconnect: vi.fn() },
    position: 0,
    paused: false,
  };
}

beforeEach(() => {
  initMusic(makeShoukaku() as any);
});

afterEach(() => {
  deleteQueue(GUILD);
  vi.clearAllMocks();
});

describe("queue drift guards — playSong rejects stale/dead queue references", () => {
  it("a destroyed (stopped) queue cannot be replayed by a late event", async () => {
    const shoukaku = makeShoukaku();
    initMusic(shoukaku as any);

    const queue: any = createQueue(GUILD, { id: "vc1" } as any, { id: "tc1" } as any);
    const player = makePlayer();
    queue.player = player; // grab the spy now — deleteQueue nulls queue.player
    queue.songs = [{ title: "Song A", url: "https://x/a" }];

    // stop → deleteQueue sets _destroyed, nulls the player, removes from map.
    deleteQueue(GUILD);
    expect(getQueue(GUILD)).toBeUndefined();
    expect(queue._destroyed).toBe(true);

    // A stale Lavalink "end" event would call playSong(queue) on this object.
    await playSong(queue);

    // Guard held: no track resolve, no playTrack on the (now dead) player.
    expect(shoukaku._resolve).not.toHaveBeenCalled();
    expect(player.playTrack).not.toHaveBeenCalled();
  });

  it("a stale queue whose guild was REPLACED by a fresh queue is a no-op", async () => {
    const shoukaku = makeShoukaku();
    initMusic(shoukaku as any);

    // First queue (e.g. user ran /stop then /play again → new queue object).
    const stale: any = createQueue(GUILD, { id: "vc1" } as any, { id: "tc1" } as any);
    const stalePlayer = makePlayer();
    stale.player = stalePlayer; // grab spy now — deleteQueue nulls stale.player
    stale.songs = [{ title: "Stale Song", url: "https://x/stale" }];

    // Replace it with a brand-new queue for the same guild.
    deleteQueue(GUILD);
    const fresh: any = createQueue(GUILD, { id: "vc2" } as any, { id: "tc2" } as any);
    fresh.player = makePlayer();
    fresh.songs = [{ title: "Fresh Song", url: "https://x/fresh" }];

    // queues.has(GUILD) is TRUE now (fresh exists) — the old guard would have
    // let this through. isQueueLive must reject it on identity mismatch.
    await playSong(stale);

    expect(stalePlayer.playTrack).not.toHaveBeenCalled();
    // The fresh queue is untouched by the stale call.
    expect(fresh.player.playTrack).not.toHaveBeenCalled();
  });

  it("the live queue still plays normally (guard does not over-reject)", async () => {
    const shoukaku = makeShoukaku();
    initMusic(shoukaku as any);

    const queue: any = createQueue(GUILD, { id: "vc1" } as any, { id: "tc1" } as any);
    queue.player = makePlayer();
    queue.songs = [{ title: "Song A", url: "https://x/a" }];

    await playSong(queue);

    expect(shoukaku._resolve).toHaveBeenCalledTimes(1);
    expect(queue.player.playTrack).toHaveBeenCalledTimes(1);
  });
});
