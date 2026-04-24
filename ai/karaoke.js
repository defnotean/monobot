// ─── Karaoke / Lyrics Engine (Irene) ─────────────────────────────────────────
// Syncs lyrics with Lavalink's playback position. Two display modes:
//
//   "message"  (default, safe) — sends one message, edits it with each new
//              lyric line. No nickname changes, no Discord flags.
//   "nickname" — changes the bot's server nickname to the current lyric.
//              Visible at a glance but risks rate limits on rapid changes.
//
// Trigger modes:
//   Manual:  /karaoke start <song> <artist>
//   Auto:    /karaoke auto — follows every track in the queue
//
// Lyrics from LRCLIB (free, no key). Polls Lavalink position every 800ms.

import { EmbedBuilder } from "discord.js";
import { log } from "../utils/logger.js";
import { getQueue } from "../music/player.js";

const LRCLIB_URL = "https://lrclib.net/api/get";
const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const NICK_PREFIX = "♪ ";
const NICK_MAX = 32;
const MIN_GAP_NICK_MS = 1000;   // nickname mode — Discord rate limits nick changes
const MIN_GAP_MSG_MS = 300;     // message mode — edits are cheaper, follow the actual rhythm
const POLL_INTERVAL_MS = 250;   // poll 4x/sec for responsive feel
const LOOKAHEAD_MS = 400;       // 1200 was one line ahead, 800 was behind — split the difference

const _sessions = new Map();

// Extract clean title + artist from a queue song object.
// Handles both YouTube ("Artist - Song") and Spotify ("Song - Artist") formats.
export function extractSongInfo(song) {
  if (!song) return { title: "Unknown", artist: "Unknown" };
  const raw = song.title || "Unknown";
  let artist = song.artist || "Unknown";
  let title = raw;
  if (artist !== "Unknown" && raw.includes(" - ")) {
    // Strip artist from title regardless of which side it's on
    const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = raw
      .replace(new RegExp(`\\s*[-–—]\\s*${escaped}`, "i"), "")
      .replace(new RegExp(`${escaped}\\s*[-–—]\\s*`, "i"), "")
      .trim() || raw;
  } else if (artist === "Unknown" && raw.includes(" - ")) {
    artist = raw.split(" - ")[0] || "Unknown";
    title = raw.split(" - ").slice(1).join(" - ") || raw;
  }
  return { title, artist };
}

// ─── Title/artist cleanup ────────────────────────────────────────────────────
// Lavalink titles are messy: "Bruno Mars - Marry You (Official Lyric Video)"
// or "Stereo Hearts (feat. Adam Levine) - Gym Class Heroes, Adam Levine"
// LRCLIB needs clean "Stereo Hearts" + "Gym Class Heroes" to match.

function cleanTitle(raw) {
  return raw
    .replace(/\s*[\(\[【](?:official|lyric|music|audio|hd|hq|ft\.?|feat\.?|with|prod\.?|visuali[sz]er|video|mv|remaster|live|acoustic|remix|version|radio edit|clean|explicit)[^\)\]】]*[\)\]】]/gi, "")
    .replace(/\s*[\(\[【][^\)\]】]{0,5}[\)\]】]/g, "") // short parenthetical junk
    .replace(/\s*[-–—|]\s*(official|lyric|music|audio|hd|hq|video|mv|visuali[sz]er).*/i, "")
    .replace(/\s+/g, " ").trim();
}

function cleanArtist(raw) {
  // Take first artist before comma/feat/&/x — LRCLIB matches better on primary artist
  return raw
    .split(/[,&×x]|\bfeat\.?\b|\bft\.?\b|\bwith\b/i)[0]
    .replace(/\s*[\(\[].*/g, "")
    .trim();
}

// Split "Artist - Title" format common in YouTube/Lavalink titles
function splitArtistTitle(fullTitle, fallbackArtist) {
  // "Gym Class Heroes - Stereo Hearts" → artist="Gym Class Heroes", title="Stereo Hearts"
  const m = fullTitle.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) {
    return { artist: cleanArtist(m[1]), title: cleanTitle(m[2]) };
  }
  return { artist: cleanArtist(fallbackArtist || ""), title: cleanTitle(fullTitle) };
}

// ─── LRCLIB ──────────────────────────────────────────────────────────────────

export async function fetchSyncedLyrics(rawTrackName, rawArtistName) {
  // If caller already separated artist and title, clean them individually.
  // Only use splitArtistTitle when the title looks like "Artist - Song".
  let trackName, artistName;
  if (rawArtistName && rawArtistName !== "Unknown" && !rawTrackName.includes(rawArtistName)) {
    // Caller gave us clean separate fields — just clean, don't re-split
    trackName = cleanTitle(rawTrackName);
    artistName = cleanArtist(rawArtistName);
  } else {
    // Title might contain "Artist - Song" — split it
    const split = splitArtistTitle(rawTrackName, rawArtistName);
    trackName = split.title || cleanTitle(rawTrackName);
    artistName = split.artist || cleanArtist(rawArtistName);
  }

  log(`[KARAOKE] Searching LRCLIB: "${trackName}" by "${artistName}"`);

  // Try exact match first
  try {
    const url = `${LRCLIB_URL}?artist_name=${encodeURIComponent(artistName)}&track_name=${encodeURIComponent(trackName)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      if (json?.syncedLyrics) return json;
    }
  } catch (e) { log(`[KARAOKE] LRCLIB direct: ${e.message}`); }

  // Search fallback with cleaned query
  try {
    const url = `${LRCLIB_SEARCH}?q=${encodeURIComponent(`${artistName} ${trackName}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const results = await res.json();
      // Pick the result that best matches our artist + title.
      // CRITICAL: don't just pick any result from the same artist — verify the
      // title actually matches. "Hollywood" by Rozei ≠ "Ooo La La" by Rozei.
      const withSynced = (results || []).filter(r => r.syncedLyrics);
      if (withSynced.length) {
        const lowerArtist = artistName.toLowerCase();
        const lowerTitle = trackName.toLowerCase();
        const scored = withSynced.map(r => {
          const rTitle = (r.trackName || "").toLowerCase();
          const rArtist = (r.artistName || "").toLowerCase();
          let score = 0;
          // Title match is REQUIRED — without it we might return a completely different song
          if (rTitle === lowerTitle) score += 10;
          else if (rTitle.includes(lowerTitle) || lowerTitle.includes(rTitle)) score += 5;
          // Artist is a bonus
          if (rArtist.includes(lowerArtist) || lowerArtist.includes(rArtist)) score += 3;
          return { ...r, _score: score };
        });
        scored.sort((a, b) => b._score - a._score);
        // Only return if title actually matched (score >= 5)
        if (scored[0]._score >= 5) {
          log(`[KARAOKE] LRCLIB matched: "${scored[0].trackName}" by ${scored[0].artistName} (score: ${scored[0]._score})`);
          return scored[0];
        }
        log(`[KARAOKE] LRCLIB search returned results but no title match (best: "${scored[0].trackName}" score ${scored[0]._score})`);
      }
    }
  } catch (e) { log(`[KARAOKE] LRCLIB search: ${e.message}`); }

  return null;
}

// ─── LRC parser ──────────────────────────────────────────────────────────────

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
      lines.push({ timeMs: (min * 60 + sec + cs) * 1000, text });
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function formatNick(text) {
  const clean = text.replace(/[\[\]<>]/g, "").trim();
  const room = NICK_MAX - NICK_PREFIX.length;
  return NICK_PREFIX + (clean.length > room ? clean.slice(0, room - 1) + "…" : clean);
}

async function setNick(guild, nick) {
  try {
    const me = guild.members.me ?? await guild.members.fetch(guild.client.user.id).catch(() => null);
    if (me) await me.setNickname(nick);
  } catch (e) { log(`[KARAOKE] Nick failed: ${e.message}`); }
}

function buildLyricEmbed(session, lineIdx) {
  const CONTEXT = 3; // lines before/after the current line
  const lines = session.lyrics;
  const start = Math.max(0, lineIdx - CONTEXT);
  const end = Math.min(lines.length - 1, lineIdx + CONTEXT);

  const display = [];
  for (let i = start; i <= end; i++) {
    const text = lines[i].text;
    if (i === lineIdx) {
      display.push(`**► ${text}**`);           // current line highlighted
    } else if (i < lineIdx) {
      display.push(`-# ${text}`);               // past lines dimmed
    } else {
      display.push(`${text}`);                   // upcoming lines normal
    }
  }

  const elapsed = Math.floor(lines[lineIdx].timeMs / 1000);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return new EmbedBuilder()
    .setColor(0xff3aa9)
    .setTitle(`🎤 ${session.trackName}`)
    .setDescription(display.join("\n"))
    .setFooter({ text: `${session.artistName} · ${mm}:${ss} · ${session.displayMode} mode` });
}

// ─── Polling engine ──────────────────────────────────────────────────────────

function startPolling(session) {
  stopPolling(session);

  let lastLineIdx = -1;
  let lastUpdateMs = 0;
  let lastTrackTitle = session.trackName;

  // Smooth position tracking — Lavalink reports position sporadically via WS.
  // Between updates, we interpolate locally so lyrics don't stutter/lag.
  let lastLavalinkPos = 0;
  let lastLavalinkReadAt = 0;

  session.pollId = setInterval(async () => {
    const queue = getQueue(session.guildId);

    // Auto-stop if music stopped, queue empty, or bot disconnected from voice
    if (!queue || !queue.playing || !queue.songs?.length || !queue.player) {
      log(`[KARAOKE] Music stopped or disconnected — auto-stopping lyrics`);
      stopKaraoke(session.guildId, "music stopped");
      return;
    }

    // Track-change detection — if the music player moved to a different song,
    // auto-fetch new lyrics instead of showing stale ones from the old track.
    if (queue?.songs?.[0]) {
      const currentTitle = queue.songs[0].title;
      if (currentTitle && currentTitle !== lastTrackTitle) {
        lastTrackTitle = currentTitle;
        const { title, artist } = extractSongInfo(queue.songs[0]);
        log(`[KARAOKE] Track changed to "${title}" by ${artist} — fetching new lyrics`);

        const result = await fetchSyncedLyrics(title, artist);
        if (result?.syncedLyrics) {
          session.lyrics = parseLRC(result.syncedLyrics);
          session.trackName = result.trackName ?? title;
          session.artistName = result.artistName ?? artist;
        } else {
          session.lyrics = [];
          session.trackName = title;
          session.artistName = artist;
        }
        session.startedAt = Date.now();
        session.offsetMs = 0;
        session.currentLine = null;
        lastLineIdx = -1;
        lastLavalinkPos = 0;
        lastLavalinkReadAt = Date.now();

        // In message mode, send a new embed for the new track
        if (session.displayMode === "message" && session.channelId) {
          try {
            const guild = session.client.guilds.cache.get(session.guildId);
            const ch = guild?.channels?.cache.get(session.channelId);
            if (ch) {
              if (session.lyricsMessage) session.lyricsMessage.delete().catch(() => {});
              if (session.lyrics.length) {
                session.lyricsMessage = await ch.send({ embeds: [buildLyricEmbed(session, 0)] });
              } else {
                const { EmbedBuilder } = await import("discord.js");
                session.lyricsMessage = await ch.send({ embeds: [
                  new EmbedBuilder().setColor(0xff3aa9).setTitle(`🎤 ${session.trackName}`).setDescription("*no synced lyrics found*").setFooter({ text: session.artistName })
                ]});
              }
            }
          } catch {}
        }
        return; // skip this tick, start fresh next poll
      }
    }

    // Smooth position: use Lavalink when fresh, interpolate when stale.
    // Lavalink updates position every ~1-5s. Between updates, we estimate
    // by adding elapsed time to the last known position. This prevents
    // lyrics from freezing between Lavalink WS updates.
    const now = Date.now();
    const lavalinkPos = queue?.player?.position;
    let rawPos;
    if (lavalinkPos != null && lavalinkPos > 0) {
      if (lavalinkPos !== lastLavalinkPos) {
        // New position from Lavalink — anchor our interpolation here
        lastLavalinkPos = lavalinkPos;
        lastLavalinkReadAt = now;
        rawPos = lavalinkPos;
      } else {
        // Stale — interpolate forward from last known position
        rawPos = lastLavalinkPos + (now - lastLavalinkReadAt);
      }
    } else {
      // No Lavalink — pure local timer
      rawPos = now - session.startedAt + session.offsetMs;
    }
    const posMs = rawPos + LOOKAHEAD_MS;

    let lineIdx = -1;
    for (let i = session.lyrics.length - 1; i >= 0; i--) {
      if (session.lyrics[i].timeMs <= posMs) { lineIdx = i; break; }
    }

    if (lineIdx === lastLineIdx) return;
    lastLineIdx = lineIdx;
    if (lineIdx < 0) return;

    // Dynamic throttle — message edits follow the song's actual rhythm,
    // nickname changes need more spacing to avoid Discord rate limits
    const minGap = session.displayMode === "nickname" ? MIN_GAP_NICK_MS : MIN_GAP_MSG_MS;
    if (now - lastUpdateMs < minGap) return;
    lastUpdateMs = now;

    session.currentLine = session.lyrics[lineIdx].text;
    const guild = session.client.guilds.cache.get(session.guildId);
    if (!guild) return;

    // ── Display mode dispatch ──
    if (session.displayMode === "nickname") {
      await setNick(guild, formatNick(session.currentLine));
    } else {
      // Message mode — keep the lyrics embed at the bottom of the channel.
      // If other messages pushed it up, delete the old one and re-send so
      // it's always the last message visible.
      try {
        const ch = guild.channels.cache.get(session.channelId);
        if (!ch) return;

        if (session.lyricsMessage) {
          // Check if our message is still the latest in the channel
          const isLatest = ch.lastMessageId === session.lyricsMessage.id;
          if (isLatest) {
            // Still at the bottom — just edit in place (cheap)
            await session.lyricsMessage.edit({ embeds: [buildLyricEmbed(session, lineIdx)] });
          } else {
            // Buried by other messages — delete and re-send to the bottom
            session.lyricsMessage.delete().catch(() => {});
            session.lyricsMessage = await ch.send({ embeds: [buildLyricEmbed(session, lineIdx)] });
          }
        } else {
          session.lyricsMessage = await ch.send({ embeds: [buildLyricEmbed(session, lineIdx)] });
        }
      } catch (e) {
        // Message deleted or channel gone — re-send
        if (e.code === 10008 || e.code === 10003) {
          try {
            const ch = guild.channels.cache.get(session.channelId);
            if (ch) session.lyricsMessage = await ch.send({ embeds: [buildLyricEmbed(session, lineIdx)] });
          } catch {}
        }
      }
    }

    // Auto-stop after last lyric + 5s
    if (lineIdx === session.lyrics.length - 1 && posMs > session.lyrics[lineIdx].timeMs + 5000) {
      stopKaraoke(session.guildId, "song ended");
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling(session) {
  if (session.pollId) { clearInterval(session.pollId); session.pollId = null; }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.trackName
 * @param {string} opts.artistName
 * @param {string} opts.requesterId
 * @param {"message"|"nickname"} [opts.mode="message"]
 * @param {string} [opts.channelId] — required for message mode
 */
export async function startKaraoke(client, guildId, opts) {
  const { trackName, artistName, requesterId, mode = "message", channelId } = opts;
  if (_sessions.has(guildId)) await stopKaraoke(guildId, "replaced");

  const result = await fetchSyncedLyrics(trackName, artistName);
  if (!result?.syncedLyrics) return { ok: false, reason: `no synced lyrics found for **${trackName}** by **${artistName}**` };

  const lyrics = parseLRC(result.syncedLyrics);
  if (!lyrics.length) return { ok: false, reason: "lyrics file is empty or unparseable" };

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, reason: "guild not found" };
  const me = guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);

  const session = {
    guildId, client, displayMode: mode,
    trackName: result.trackName ?? trackName,
    artistName: result.artistName ?? artistName,
    lyrics, originalNick: me?.nickname ?? null,
    requesterId, channelId,
    startedAt: Date.now(), offsetMs: 0,
    currentLine: null, pollId: null,
    autoMode: false,
    lyricsMessage: null, // for message mode
  };

  // Sync to Lavalink position if music is playing
  const queue = getQueue(guildId);
  if (queue?.player?.position > 0) {
    session.startedAt = Date.now() - queue.player.position;
  }

  // For message mode, send the initial lyrics embed
  if (mode === "message" && channelId) {
    try {
      const ch = guild.channels.cache.get(channelId);
      if (ch) {
        session.lyricsMessage = await ch.send({ embeds: [buildLyricEmbed(session, 0)] });
      }
    } catch (e) { log(`[KARAOKE] Initial message failed: ${e.message}`); }
  }

  _sessions.set(guildId, session);
  startPolling(session);

  log(`[KARAOKE] Started "${session.trackName}" by ${session.artistName} in ${guildId} (${lyrics.length} lines, ${mode} mode)`);
  return { ok: true, trackName: session.trackName, artistName: session.artistName, lineCount: lyrics.length, mode };
}

export async function stopKaraoke(guildId, reason = "stopped") {
  const session = _sessions.get(guildId);
  if (!session) return { ok: false, reason: "no karaoke running" };

  stopPolling(session);

  if (session.displayMode === "nickname") {
    const guild = session.client.guilds.cache.get(guildId);
    if (guild) await setNick(guild, session.originalNick);
  } else if (session.lyricsMessage) {
    // Final edit showing it's done
    try {
      await session.lyricsMessage.edit({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle("🎤 Lyrics ended").setDescription(`*${session.trackName}* by *${session.artistName}*`)]
      });
    } catch {}
  }

  const track = session.trackName;
  _sessions.delete(guildId);
  log(`[KARAOKE] Stopped in ${guildId} (${reason})`);
  return { ok: true, trackName: track };
}

export function setOffset(guildId, deltaMs) {
  const session = _sessions.get(guildId);
  if (!session) return { ok: false, reason: "no karaoke running" };
  session.offsetMs += deltaMs;
  return { ok: true, totalOffsetMs: session.offsetMs };
}

export function getStatus(guildId) {
  const session = _sessions.get(guildId);
  if (!session) return null;
  const queue = getQueue(guildId);
  const posMs = queue?.player?.position ?? (Date.now() - session.startedAt + session.offsetMs);
  return {
    trackName: session.trackName, artistName: session.artistName,
    elapsedMs: posMs, currentLine: session.currentLine,
    autoMode: session.autoMode, lineCount: session.lyrics.length,
    offsetMs: session.offsetMs, displayMode: session.displayMode,
  };
}

export function hasSession(guildId) {
  return _sessions.has(guildId);
}

// ─── Auto-mode hooks — called from music/player.js on track start/end ──────

export async function onTrackStart(client, guildId, songTitle, songArtist) {
  const session = _sessions.get(guildId);
  if (!session?.autoMode) return;

  log(`[KARAOKE/auto] New track: "${songTitle}" by ${songArtist}`);
  stopPolling(session);

  const result = await fetchSyncedLyrics(songTitle, songArtist);
  if (!result?.syncedLyrics) {
    log(`[KARAOKE/auto] No synced lyrics for "${songTitle}"`);
    if (session.displayMode === "nickname") {
      const guild = client.guilds.cache.get(guildId);
      if (guild) await setNick(guild, formatNick(songTitle));
    } else if (session.lyricsMessage) {
      try {
        await session.lyricsMessage.edit({
          embeds: [new EmbedBuilder().setColor(0xff3aa9).setTitle(`🎤 ${songTitle}`).setDescription("*no synced lyrics found for this track*").setFooter({ text: songArtist })]
        });
      } catch {}
    }
    return;
  }

  session.lyrics = parseLRC(result.syncedLyrics);
  session.trackName = result.trackName ?? songTitle;
  session.artistName = result.artistName ?? songArtist;
  session.startedAt = Date.now();
  session.offsetMs = 0;
  session.currentLine = null;

  // For message mode, send a new embed for the new track
  if (session.displayMode === "message" && session.channelId) {
    try {
      const guild = client.guilds.cache.get(guildId);
      const ch = guild?.channels?.cache.get(session.channelId);
      if (ch) session.lyricsMessage = await ch.send({ embeds: [buildLyricEmbed(session, 0)] });
    } catch {}
  }

  startPolling(session);
}

export async function onTrackEnd(client, guildId) {
  const session = _sessions.get(guildId);
  if (!session?.autoMode) return;
  stopPolling(session);
  if (session.displayMode === "nickname") {
    const guild = client.guilds.cache.get(guildId);
    if (guild) await setNick(guild, session.originalNick);
  }
  // In message mode, leave the last lyrics showing — new track will send a new message
}

export async function enableAutoMode(client, guildId, requesterId, { mode = "message", channelId } = {}) {
  if (_sessions.has(guildId)) await stopKaraoke(guildId, "replaced by auto");

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, reason: "guild not found" };
  const me = guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);

  const session = {
    guildId, client, displayMode: mode, channelId,
    trackName: "(waiting for track…)", artistName: "",
    lyrics: [], originalNick: me?.nickname ?? null, requesterId,
    startedAt: Date.now(), offsetMs: 0, currentLine: null,
    pollId: null, autoMode: true, lyricsMessage: null,
  };
  _sessions.set(guildId, session);

  // If something is already playing, start immediately
  const queue = getQueue(guildId);
  if (queue?.songs?.length && queue.playing) {
    const { title, artist } = extractSongInfo(queue.songs[0]);
    await onTrackStart(client, guildId, title, artist);
  }

  log(`[KARAOKE] Auto-mode enabled in ${guildId} (${mode} mode)`);
  return { ok: true };
}
