// ─── Last.fm API Client ───────────────────────────────────────────────────────
// Wraps all read-only Last.fm API endpoints needed for fm commands.
// Authentication (session key) is NOT required — public read uses api_key only.

import config from "../config.js";

const BASE = "https://ws.audioscrobbler.com/2.0/";

export class LastFMError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "LastFMError";
  }
}

async function call(method, params = {}) {
  const qs = new URLSearchParams({
    method,
    api_key: config.lastfmApiKey,
    format: "json",
    ...params,
  });

  const res = await fetch(`${BASE}?${qs}`, {
    headers: { "User-Agent": "Eris-Discord-Bot/1.0" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new LastFMError(`HTTP ${res.status}`, res.status);

  const data = await res.json();
  if (data.error) throw new LastFMError(data.message || "Last.fm error", data.error);
  return data;
}

// Small delay helper — used between batched API calls to respect rate limits
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── User endpoints ───────────────────────────────────────────────────────────

export async function getRecentTracks(username, limit = 10, page = 1) {
  const data = await call("user.getRecentTracks", { user: username, limit, page, extended: 0 });
  return data.recenttracks;
}

export async function getNowPlaying(username) {
  const data = await call("user.getRecentTracks", { user: username, limit: 1 });
  const tracks = data.recenttracks?.track;
  if (!tracks) return { track: null, isNowPlaying: false };
  const track = Array.isArray(tracks) ? tracks[0] : tracks;
  const isNowPlaying = track?.["@attr"]?.nowplaying === "true";
  return { track: track || null, isNowPlaying };
}

export async function getTopArtists(username, period = "overall", limit = 10) {
  const data = await call("user.getTopArtists", { user: username, period, limit });
  const artists = data.topartists?.artist || [];
  return Array.isArray(artists) ? artists : [artists];
}

export async function getTopAlbums(username, period = "overall", limit = 10) {
  const data = await call("user.getTopAlbums", { user: username, period, limit });
  const albums = data.topalbums?.album || [];
  return Array.isArray(albums) ? albums : [albums];
}

export async function getTopTracks(username, period = "overall", limit = 10) {
  const data = await call("user.getTopTracks", { user: username, period, limit });
  const tracks = data.toptracks?.track || [];
  return Array.isArray(tracks) ? tracks : [tracks];
}

export async function getUserInfo(username) {
  const data = await call("user.getInfo", { user: username });
  return data.user;
}

// ─── Artist endpoints ─────────────────────────────────────────────────────────

export async function getArtistInfo(artist, username = null) {
  const params = { artist, autocorrect: 1 };
  if (username) params.username = username;
  const data = await call("artist.getInfo", params);
  return data.artist;
}

export async function getArtistTopAlbums(artist, limit = 5) {
  const data = await call("artist.getTopAlbums", { artist, autocorrect: 1, limit });
  const albums = data.topalbums?.album || [];
  return Array.isArray(albums) ? albums : [albums];
}

// ─── Album endpoints ──────────────────────────────────────────────────────────

export async function getAlbumInfo(artist, album, username = null) {
  const params = { artist, album, autocorrect: 1 };
  if (username) params.username = username;
  const data = await call("album.getInfo", params);
  return data.album;
}

// ─── Track endpoints ──────────────────────────────────────────────────────────

export async function getTrackInfo(artist, track, username = null) {
  const params = { artist, track, autocorrect: 1 };
  if (username) params.username = username;
  const data = await call("track.getInfo", params);
  return data.track;
}

// ─── Tag (genre) endpoints ────────────────────────────────────────────────────

export async function getTagTopArtists(tag, limit = 10) {
  const data = await call("tag.getTopArtists", { tag, limit });
  const artists = data.topartists?.artist || [];
  return Array.isArray(artists) ? artists : [artists];
}

export async function getTagTopAlbums(tag, limit = 10) {
  const data = await call("tag.getTopAlbums", { tag, limit });
  const albums = data.topalbums?.album || [];
  return Array.isArray(albums) ? albums : [albums];
}

export async function getTagInfo(tag) {
  const data = await call("tag.getInfo", { tag });
  return data.tag;
}

// ─── Monthly scrobble count (for year-in-review breakdown) ───────────────────
// Uses getRecentTracks with from/to + limit=1 to read the `total` attr without
// downloading all tracks. Makes 12 calls batched in groups of 4.

export async function getMonthlyScrobbleCounts(username, year) {
  const months = Array.from({ length: 12 }, (_, m) => {
    const from = Math.floor(new Date(year, m, 1).getTime() / 1000);
    // last second of the last day of the month
    const to   = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);
    return { from, to, m };
  });

  const counts = new Array(12).fill(0);
  const BATCH  = 4;

  for (let i = 0; i < months.length; i += BATCH) {
    const batch = months.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(({ from, to, m }) =>
        call("user.getRecentTracks", { user: username, from, to, limit: 1 })
          .then(d => ({ m, count: parseInt(d.recenttracks?.["@attr"]?.total || 0) }))
          .catch(() => ({ m, count: 0 }))
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled") counts[r.value.m] = r.value.count;
    }
    if (i + BATCH < months.length) await sleep(300);
  }

  return counts; // index 0 = January, 11 = December
}

// ─── Streak calculation ───────────────────────────────────────────────────────
// Fetches recent tracks page by page until a gap is found or maxPages reached.
// Returns { current, longest, active, todayCount }.

export async function getStreakData(username, maxPages = 8) {
  const perPage = 200;
  const dateCounts = new Map(); // "YYYY-MM-DD" => scrobble count that day

  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await call("user.getRecentTracks", { user: username, limit: perPage, page });
    } catch { break; }

    const raw = data.recenttracks?.track;
    if (!raw) break;
    const tracks = Array.isArray(raw) ? raw : [raw];
    if (!tracks.length) break;

    for (const t of tracks) {
      if (t["@attr"]?.nowplaying === "true") continue;
      if (!t.date?.uts) continue;
      const d = utcDay(parseInt(t.date.uts));
      dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
    }

    // Stop if the oldest track on this page is >120 days ago
    const oldest = tracks[tracks.length - 1];
    if (oldest?.date?.uts) {
      const daysAgo = (Date.now() / 1000 - parseInt(oldest.date.uts)) / 86400;
      if (daysAgo > 120) break;
    }

    if (tracks.length < perPage) break;
    if (page < maxPages) await sleep(150);
  }

  const today     = utcDay(Date.now() / 1000);
  const yesterday = utcDay(Date.now() / 1000 - 86400);

  // Sort all unique days descending
  const days = [...dateCounts.keys()].sort().reverse();
  if (!days.length) return { current: 0, active: false, todayCount: 0 };

  const active = days[0] >= yesterday;
  const todayCount = dateCounts.get(today) || 0;

  let current = 0;
  if (active) {
    let prev = days[0];
    current = 1;
    for (let i = 1; i < days.length; i++) {
      const gap = daysBetween(days[i], prev);
      if (gap === 1) { current++; prev = days[i]; }
      else break;
    }
  }

  return { current, active, todayCount };
}

function utcDay(unixSec) {
  const d = new Date(unixSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function daysBetween(older, newer) {
  const a = new Date(older + "T00:00:00Z");
  const b = new Date(newer + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

// ─── Bulk index fetches ───────────────────────────────────────────────────────

export async function getAllTopArtists(username, limit = 500) {
  const perPage = 200;
  const pages   = Math.ceil(limit / perPage);
  const results = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const artists = await getTopArtists(username, "overall", Math.min(perPage, limit - results.length));
      if (!artists.length) break;
      results.push(...artists);
      if (artists.length < perPage) break;
    } catch { break; }
    if (page < pages) await sleep(150);
  }

  return results;
}

export async function getAllTopAlbums(username, limit = 300) {
  const perPage = 200;
  const pages   = Math.ceil(limit / perPage);
  const results = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const albums = await getTopAlbums(username, "overall", Math.min(perPage, limit - results.length));
      if (!albums.length) break;
      results.push(...albums);
      if (albums.length < perPage) break;
    } catch { break; }
    if (page < pages) await sleep(150);
  }

  return results;
}

export async function getAllTopTracks(username, limit = 300) {
  const perPage = 200;
  const pages   = Math.ceil(limit / perPage);
  const results = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const tracks = await getTopTracks(username, "overall", Math.min(perPage, limit - results.length));
      if (!tracks.length) break;
      results.push(...tracks);
      if (tracks.length < perPage) break;
    } catch { break; }
    if (page < pages) await sleep(150);
  }

  return results;
}
