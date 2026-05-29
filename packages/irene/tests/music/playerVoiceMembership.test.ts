// Regression — the bot used to keep streaming to an empty voice channel for
// hours (Lavalink bandwidth + paid-source cost). handleVoiceMembershipChange
// pauses when the bot is alone and schedules a disconnect after a grace
// period; a human rejoining cancels it and resumes. Also covers the Spotify
// SSRF host check, which must reject substring-bypass URLs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({ log: vi.fn() }));

import {
  createQueue,
  deleteQueue,
  getQueue,
  handleVoiceMembershipChange,
  isSpotifyHost,
} from "../../music/player.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────
// A Discord GuildVoiceChannel exposes `.members` as a Collection (has a
// `.filter(fn).size`). We model just that surface.
function makeChannel(memberBots: boolean[]) {
  const members = memberBots.map((bot, i) => ({ id: `u${i}`, user: { bot } }));
  return {
    id: "vc1",
    members: {
      filter(fn: (m: any) => boolean) {
        const kept = members.filter(fn);
        return { size: kept.length };
      },
    },
  };
}

function makePlayer() {
  return {
    paused: false,
    setPaused(v: boolean) { this.paused = v; },
    stopTrack() {},
    connection: { disconnect() {} },
    removeAllListeners() {},
  };
}

const GUILD = "guild-alone-test";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  deleteQueue(GUILD);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("handleVoiceMembershipChange — alone-in-VC pause + disconnect", () => {
  it("pauses and schedules a disconnect when the bot is alone (only bots left)", () => {
    const channel = makeChannel([true]); // just the bot
    const queue: any = createQueue(GUILD, channel as any, null);
    queue.player = makePlayer();
    queue.playing = true;

    const result = handleVoiceMembershipChange(GUILD, { graceMs: 1000 });

    expect(result.action).toBe("alone");
    expect(result.scheduledDisconnect).toBe(true);
    expect(queue.player.paused).toBe(true);
    expect(queue._pausedForEmpty).toBe(true);
    expect(queue._aloneDisconnectTimer).not.toBeNull();
    // Still connected before grace elapses.
    expect(getQueue(GUILD)).toBe(queue);
  });

  it("disconnects after the grace period if still alone", () => {
    const channel = makeChannel([true]);
    const queue: any = createQueue(GUILD, channel as any, null);
    queue.player = makePlayer();
    queue.playing = true;

    handleVoiceMembershipChange(GUILD, { graceMs: 1000 });
    expect(getQueue(GUILD)).toBe(queue);

    vi.advanceTimersByTime(1000);

    // Grace elapsed, still alone → queue torn down.
    expect(getQueue(GUILD)).toBeUndefined();
  });

  it("cancels the disconnect and resumes when a human rejoins", () => {
    const aloneChannel = makeChannel([true]);
    const queue: any = createQueue(GUILD, aloneChannel as any, null);
    queue.player = makePlayer();
    queue.playing = true;

    handleVoiceMembershipChange(GUILD, { graceMs: 1000 });
    expect(queue.player.paused).toBe(true);
    expect(queue._aloneDisconnectTimer).not.toBeNull();

    // A human rejoins — swap the channel's membership and re-evaluate.
    queue.voiceChannel = makeChannel([true, false]); // bot + human
    const result = handleVoiceMembershipChange(GUILD, { graceMs: 1000 });

    expect(result.action).toBe("occupied");
    expect(result.resumed).toBe(true);
    expect(queue.player.paused).toBe(false);
    expect(queue._pausedForEmpty).toBe(false);
    expect(queue._aloneDisconnectTimer).toBeNull();

    // The previously-armed disconnect must NOT fire now.
    vi.advanceTimersByTime(5000);
    expect(getQueue(GUILD)).toBe(queue);
  });

  it("does not re-arm a second timer if called again while still alone", () => {
    const channel = makeChannel([true]);
    const queue: any = createQueue(GUILD, channel as any, null);
    queue.player = makePlayer();
    queue.playing = true;

    handleVoiceMembershipChange(GUILD, { graceMs: 1000 });
    const firstTimer = queue._aloneDisconnectTimer;
    handleVoiceMembershipChange(GUILD, { graceMs: 1000 });
    expect(queue._aloneDisconnectTimer).toBe(firstTimer);
  });

  it("does not pause an idle (not-playing) player, and does not resume it on rejoin", () => {
    // Player exists/connected but nothing is playing (queue.playing === false).
    const channel = makeChannel([true]); // just the bot
    const queue: any = createQueue(GUILD, channel as any, null);
    queue.player = makePlayer();
    queue.playing = false;

    // Alone, but idle — we still arm the disconnect timer for cost control,
    // but must NOT pause a player that wasn't playing.
    const aloneResult = handleVoiceMembershipChange(GUILD, { graceMs: 1000 });
    expect(aloneResult.action).toBe("alone");
    expect(aloneResult.scheduledDisconnect).toBe(true);
    expect(queue.player.paused).toBe(false);
    expect(queue._pausedForEmpty).toBeFalsy();

    // A human rejoins — since we never paused, we must NOT resume.
    queue.voiceChannel = makeChannel([true, false]); // bot + human
    const rejoinResult = handleVoiceMembershipChange(GUILD, { graceMs: 1000 });
    expect(rejoinResult.action).toBe("occupied");
    expect(rejoinResult.resumed).toBe(false);
    expect(queue.player.paused).toBe(false);
    expect(queue._aloneDisconnectTimer).toBeNull();
  });

  it("is a no-op when no queue exists for the guild", () => {
    expect(handleVoiceMembershipChange("no-such-guild")).toEqual({ action: "no-queue" });
  });
});

describe("isSpotifyHost — SSRF allowlist for the Spotify scrape fallback", () => {
  it("rejects substring-bypass URLs", () => {
    expect(isSpotifyHost("https://evil.com/spotify.com")).toBe(false);
    expect(isSpotifyHost("https://spotify.com.evil.com/track")).toBe(false);
    expect(isSpotifyHost("https://notspotify.com/x")).toBe(false);
    expect(isSpotifyHost("not a url at all")).toBe(false);
  });

  it("accepts real Spotify hosts", () => {
    expect(isSpotifyHost("https://open.spotify.com/track/abc123")).toBe(true);
    expect(isSpotifyHost("https://spotify.com/track/abc123")).toBe(true);
    expect(isSpotifyHost("https://api.spotify.com/v1/x")).toBe(true);
  });
});
