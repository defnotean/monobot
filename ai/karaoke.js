// ─── Karaoke Engine ──────────────────────────────────────────────────────────
// Irene-only feature: bot's nickname becomes a live lyric display, syncing line-by-line
// with a song. Two modes:
//   1. Manual:  /karaoke start <song>  → fetches synced lyrics, plays from time 0
//   2. Auto:    /karaoke auto <fmuser> → polls Last.fm; when a new track is detected,
//                                         fetches lyrics and plays from the start
//
// Lyrics source: LRCLIB (https://lrclib.net) — free, no API key, has synced LRC.
// Discord nickname rate limit: ~2/sec/guild — we throttle to a 1.2s minimum gap
// and skip lines that come too fast.

import { log } from "../utils/logger.js";
import { getNowPlaying } from "../lastfm/api.js";

const LRCLIB_URL = "https://lrclib.net/api/get";
const LRCLIB_SEARCH_URL = "https://lrclib.net/api/search";
const NICK_PREFIX = "♪ ";
const NICK_MAX = 32;
const MIN_GAP_MS = 1200;          // throttle nickname updates to avoid rate limits
const AUTO_POLL_INTERVAL_MS = 30_000;

// guildId → KaraokeSession
const _sessions = new Map();

// Identity check — feature is gated to Irene only since both bots share a codebase
export function isIrene(client) {
  return client?.user?.username?.toLowerCase().includes("irene") ?? false;
}

// ─── LRCLIB ──────────────────────────────────────────────────────────────────

export async function fetchSyncedLyrics(trackName, artistName) {
  // Try exact-match endpoint first (fastest)
  try {
    const url = `${LRCLIB_URL}?artist_name=${encodeURIComponent(artistName)}&track_name=${encodeURIComponent(trackName)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const json = await res.json();
      if (json?.syncedLyrics) {
        return { syncedLyrics: json.syncedLyrics, trackName: json.trackName, artistName: json.artistName, duration: json.duration };
      }
    }
  } catch (e) { log(`[KARAOKE] LRCLIB direct fetch failed: ${e.message}`); }

  // Fall back to search endpoint — picks the best match with synced lyrics
  try {
    const url = `${LRCLIB_SEARCH_URL}?q=${encodeURIComponent(`${artistName} ${trackName}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const results = await res.json();
    const withSynced = (results || []).find(r => r.syncedLyrics);
    if (withSynced) {
      return { syncedLyrics: withSynced.syncedLyrics, trackName: withSynced.trackName, artistName: withSynced.artistName, duration: withSynced.duration };
    }
  } catch (e) { log(`[KARAOKE] LRCLIB search failed: ${e.message}`); }

  return null;
}

// ─── LRC parser ──────────────────────────────────────────────────────────────
// Format: [mm:ss.cc]Lyric line — multiple timestamps possible per line

export function parseLRC(lrcText) {
  const lines = [];
  const tsRx = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  for (const raw of lrcText.split(/\r?\n/)) {
    const text = raw.replace(tsRx, "").trim();
    if (!text) continue;
    let m;
    tsRx.lastIndex = 0;
    while ((m = tsRx.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const cs  = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0;
      lines.push({ time: min * 60 + sec + cs, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

// ─── Nickname formatting ─────────────────────────────────────────────────────

function formatNickname(text) {
  const stripped = text.replace(/[\[\]<>]/g, "").trim();
  const room = NICK_MAX - NICK_PREFIX.length;
  return NICK_PREFIX + (stripped.length > room ? stripped.slice(0, room - 1) + "…" : stripped);
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

async function _getMyMember(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);
}

async function _setNickname(member, nick) {
  try {
    await member.setNickname(nick);
    return true;
  } catch (e) {
    log(`[KARAOKE] setNickname failed: ${e.message}`);
    return false;
  }
}

function _clearTimeouts(session) {
  for (const t of session.timeouts) clearTimeout(t);
  session.timeouts = [];
}

function _scheduleLyrics(session, fromTimeSec = 0) {
  _clearTimeouts(session);
  const now = Date.now();
  let lastFireMs = -Infinity;

  // Total offset = user-set offset + how far into the song we are when (re)scheduling
  const liveOffsetSec = session.offsetSec - fromTimeSec;

  for (const lyric of session.lyrics) {
    const fireMsFromNow = (lyric.time + liveOffsetSec) * 1000;
    if (fireMsFromNow < 0) continue;
    // Throttle: skip lines that would fire within MIN_GAP_MS of the previous one
    if (fireMsFromNow - lastFireMs < MIN_GAP_MS) continue;
    lastFireMs = fireMsFromNow;

    const t = setTimeout(async () => {
      session.currentLine = lyric.text;
      session.currentTimeSec = lyric.time;
      const member = await _getMyMember(session.client, session.guildId);
      if (member) await _setNickname(member, formatNickname(lyric.text));
    }, fireMsFromNow);
    session.timeouts.push(t);
  }

  // Auto-stop ~3s after the last lyric (or after duration if known)
  const lastTime = session.lyrics[session.lyrics.length - 1]?.time ?? 0;
  const stopAfterMs = (lastTime + liveOffsetSec + 3) * 1000;
  const stopT = setTimeout(() => stopKaraoke(session.guildId, "song ended"), Math.max(stopAfterMs, 5000));
  session.timeouts.push(stopT);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function startKaraoke(client, guildId, { trackName, artistName, requesterId }) {
  if (!isIrene(client)) return { ok: false, reason: "karaoke is an Irene-only feature" };

  // Stop any existing session first
  if (_sessions.has(guildId)) await stopKaraoke(guildId, "replaced");

  const result = await fetchSyncedLyrics(trackName, artistName);
  if (!result?.syncedLyrics) return { ok: false, reason: `no synced lyrics found for **${trackName}** by **${artistName}** on LRCLIB` };

  const lyrics = parseLRC(result.syncedLyrics);
  if (!lyrics.length) return { ok: false, reason: "lyrics file is empty or unparseable" };

  const member = await _getMyMember(client, guildId);
  if (!member) return { ok: false, reason: "couldn't fetch my member object in this server" };
  if (!member.manageable && !member.guild.members.me?.permissions?.has("ChangeNickname")) {
    return { ok: false, reason: "i don't have Change Nickname permission here" };
  }

  const originalNick = member.nickname; // may be null if no nick was set
  const session = {
    guildId,
    client,
    trackName: result.trackName ?? trackName,
    artistName: result.artistName ?? artistName,
    duration: result.duration ?? 0,
    lyrics,
    timeouts: [],
    originalNick,
    requesterId,
    startedAt: Date.now(),
    pausedAtSec: null,
    offsetSec: 0,
    currentLine: null,
    currentTimeSec: 0,
    autoMode: null, // populated by startAutoMode
  };
  _sessions.set(guildId, session);

  _scheduleLyrics(session, 0);
  log(`[KARAOKE] Started "${session.trackName}" by ${session.artistName} in guild ${guildId} (${lyrics.length} lines)`);
  return { ok: true, trackName: session.trackName, artistName: session.artistName, lineCount: lyrics.length };
}

export async function stopKaraoke(guildId, reason = "stopped") {
  const session = _sessions.get(guildId);
  if (!session) return { ok: false, reason: "no karaoke is running here" };

  _clearTimeouts(session);

  // Stop auto-mode polling if active
  if (session.autoMode?.intervalId) clearInterval(session.autoMode.intervalId);

  // Restore original nickname
  const member = await _getMyMember(session.client, guildId);
  if (member) await _setNickname(member, session.originalNick); // null = remove nickname

  _sessions.delete(guildId);
  log(`[KARAOKE] Stopped in guild ${guildId} (${reason})`);
  return { ok: true, trackName: session.trackName };
}

export function pauseKaraoke(guildId) {
  const session = _sessions.get(guildId);
  if (!session) return { ok: false, reason: "no karaoke is running here" };
  if (session.pausedAtSec != null) return { ok: false, reason: "already paused" };

  session.pausedAtSec = (Date.now() - session.startedAt) / 1000 - session.offsetSec;
  _clearTimeouts(session);
  return { ok: true, atSec: session.pausedAtSec };
}

export function resumeKaraoke(guildId) {
  const session = _sessions.get(guildId);
  if (!session) return { ok: false, reason: "no karaoke is running here" };
  if (session.pausedAtSec == null) return { ok: false, reason: "not paused" };

  // Reset start anchor so timestamps land correctly when re-scheduling from pausedAtSec
  session.startedAt = Date.now();
  session.offsetSec = -session.pausedAtSec; // shift schedule by where we paused
  const at = session.pausedAtSec;
  session.pausedAtSec = null;
  _scheduleLyrics(session, at);
  return { ok: true, atSec: at };
}

export function setOffset(guildId, deltaSec) {
  const session = _sessions.get(guildId);
  if (!session) return { ok: false, reason: "no karaoke is running here" };
  session.offsetSec += deltaSec;
  // Re-schedule from current playback position
  const elapsedSec = (Date.now() - session.startedAt) / 1000 + (session.offsetSec - deltaSec);
  _scheduleLyrics(session, elapsedSec);
  return { ok: true, totalOffsetSec: session.offsetSec };
}

export function getStatus(guildId) {
  const session = _sessions.get(guildId);
  if (!session) return null;
  const elapsedSec = session.pausedAtSec != null
    ? session.pausedAtSec
    : (Date.now() - session.startedAt) / 1000;
  return {
    trackName: session.trackName,
    artistName: session.artistName,
    duration: session.duration,
    elapsedSec,
    paused: session.pausedAtSec != null,
    offsetSec: session.offsetSec,
    currentLine: session.currentLine,
    autoMode: !!session.autoMode,
    lineCount: session.lyrics.length,
  };
}

// ─── Last.fm auto mode ───────────────────────────────────────────────────────
// Polls a Last.fm user every 30s; when a new track starts, kicks off karaoke
// from time 0. (Last.fm doesn't expose playback position so this drifts —
// works best for short tracks.)

export async function startAutoMode(client, guildId, fmUsername, requesterId) {
  if (!isIrene(client)) return { ok: false, reason: "karaoke is an Irene-only feature" };

  // Ensure a session exists in auto-mode (no track yet)
  let session = _sessions.get(guildId);
  if (session) await stopKaraoke(guildId, "replaced by auto");

  let lastTrackKey = null;
  const intervalId = setInterval(async () => {
    try {
      const { track, isNowPlaying } = await getNowPlaying(fmUsername);
      if (!isNowPlaying || !track) return;
      const key = `${track.artist?.["#text"] ?? track.artist?.name}||${track.name}`;
      if (key === lastTrackKey) return;
      lastTrackKey = key;

      const artistName = track.artist?.["#text"] ?? track.artist?.name;
      const trackName  = track.name;
      log(`[KARAOKE/auto] ${fmUsername} is now playing "${trackName}" by ${artistName} — starting karaoke`);

      const result = await startKaraoke(client, guildId, { trackName, artistName, requesterId });
      if (result.ok) {
        // Re-attach auto state since startKaraoke wipes the previous session
        const s = _sessions.get(guildId);
        if (s) s.autoMode = { fmUsername, intervalId, lastTrackKey: key };
      }
    } catch (e) {
      log(`[KARAOKE/auto] poll failed: ${e.message}`);
    }
  }, AUTO_POLL_INTERVAL_MS);

  // Stash the poller on a placeholder session so /karaoke stop can clean it up
  // even before the first track is detected
  _sessions.set(guildId, {
    guildId, client, lyrics: [], timeouts: [], originalNick: null,
    trackName: "(waiting for next track…)", artistName: fmUsername,
    duration: 0, requesterId, startedAt: Date.now(),
    pausedAtSec: null, offsetSec: 0, currentLine: null, currentTimeSec: 0,
    autoMode: { fmUsername, intervalId, lastTrackKey: null },
  });

  return { ok: true, fmUsername };
}
