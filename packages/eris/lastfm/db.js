// ─── Last.fm Database Operations ─────────────────────────────────────────────
// Uses the same Supabase client as the rest of the bot (from database.js).
//
// Required Supabase tables — run this SQL in your Supabase SQL editor:
//
//   create table if not exists fm_users (
//     discord_id text primary key,
//     lastfm_username text not null,
//     created_at timestamptz default now(),
//     updated_at timestamptz default now()
//   );
//
//   create table if not exists fm_user_artists (
//     discord_id text not null,
//     artist_name text not null,
//     artist_name_lower text not null,
//     play_count integer not null default 0,
//     updated_at timestamptz default now(),
//     primary key (discord_id, artist_name_lower)
//   );
//   create index if not exists fm_user_artists_artist_idx
//     on fm_user_artists (artist_name_lower);
//
//   -- NEW (v2): album + track indexes for /fmwhoknowsalbum, /fmwhoknowstrack,
//   -- and server-wide aggregations.
//
//   create table if not exists fm_user_albums (
//     discord_id text not null,
//     artist_name text not null,
//     album_name text not null,
//     album_key text not null,  -- lower(artist)||'||'||lower(album)
//     play_count integer not null default 0,
//     updated_at timestamptz default now(),
//     primary key (discord_id, album_key)
//   );
//   create index if not exists fm_user_albums_key_idx on fm_user_albums (album_key);
//
//   create table if not exists fm_user_tracks (
//     discord_id text not null,
//     artist_name text not null,
//     track_name text not null,
//     track_key text not null,  -- lower(artist)||'||'||lower(track)
//     play_count integer not null default 0,
//     updated_at timestamptz default now(),
//     primary key (discord_id, track_key)
//   );
//   create index if not exists fm_user_tracks_key_idx on fm_user_tracks (track_key);
//
//   create table if not exists fm_crowns (
//     guild_id text not null,
//     artist_name text not null,
//     artist_name_lower text not null,
//     discord_id text not null,
//     play_count integer not null,
//     claimed_at timestamptz default now(),
//     updated_at timestamptz default now(),
//     primary key (guild_id, artist_name_lower)
//   );

import { getSupabase } from "../database.js";

// ─── User linking ─────────────────────────────────────────────────────────────

export async function getFmUser(discordId) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb
    .from("fm_users")
    .select("lastfm_username")
    .eq("discord_id", discordId)
    .single();
  return data;
}

export async function setFmUser(discordId, lastfmUsername) {
  const sb = getSupabase();
  if (!sb) throw new Error("Database not available");
  const { error } = await sb.from("fm_users").upsert({
    discord_id: discordId,
    lastfm_username: lastfmUsername,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function removeFmUser(discordId) {
  const sb = getSupabase();
  if (!sb) return;
  await sb.from("fm_users").delete().eq("discord_id", discordId);
}

// ─── WhoKnows index ───────────────────────────────────────────────────────────

export async function indexUserArtists(discordId, artists) {
  const sb = getSupabase();
  if (!sb || !artists.length) return;

  const CHUNK = 200;
  for (let i = 0; i < artists.length; i += CHUNK) {
    const rows = artists.slice(i, i + CHUNK).map(a => ({
      discord_id: discordId,
      artist_name: a.name,
      artist_name_lower: a.name.toLowerCase(),
      play_count: parseInt(String(a.playcount)) || 0,
      updated_at: new Date().toISOString(),
    }));
    await sb
      .from("fm_user_artists")
      .upsert(rows, { onConflict: "discord_id,artist_name_lower" });
  }
}

export async function getGuildWhoKnows(memberIds, artistName) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];
  const { data } = await sb
    .from("fm_user_artists")
    .select("discord_id, play_count")
    .in("discord_id", memberIds)
    .eq("artist_name_lower", artistName.toLowerCase())
    .gt("play_count", 0)
    .order("play_count", { ascending: false });
  return data || [];
}

export async function getLinkedMembers(memberIds) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];
  const results = [];
  const CHUNK = 500;
  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const { data } = await sb
      .from("fm_users")
      .select("discord_id, lastfm_username")
      .in("discord_id", memberIds.slice(i, i + CHUNK));
    if (data) results.push(...data);
  }
  return results;
}

// ─── Crowns ───────────────────────────────────────────────────────────────────

export async function getCrown(guildId, artistName) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb
    .from("fm_crowns")
    .select("discord_id, play_count, claimed_at")
    .eq("guild_id", guildId)
    .eq("artist_name_lower", artistName.toLowerCase())
    .single();
  return data;
}

/** Returns { changed, previousHolder } */
export async function updateCrown(guildId, artistName, discordId, playCount) {
  const sb = getSupabase();
  if (!sb) return { changed: false, previousHolder: null };

  const existing = await getCrown(guildId, artistName);
  if (!existing || playCount > existing.play_count) {
    await sb.from("fm_crowns").upsert({
      guild_id: guildId,
      artist_name: artistName,
      artist_name_lower: artistName.toLowerCase(),
      discord_id: discordId,
      play_count: playCount,
      updated_at: new Date().toISOString(),
      claimed_at: existing ? existing.claimed_at : new Date().toISOString(),
    }, { onConflict: "guild_id,artist_name_lower" });

    return {
      changed: true,
      previousHolder: existing && existing.discord_id !== discordId ? existing.discord_id : null,
    };
  }
  return { changed: false, previousHolder: null };
}

export async function getUserCrowns(guildId, discordId) {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb
    .from("fm_crowns")
    .select("artist_name, play_count, claimed_at")
    .eq("guild_id", guildId)
    .eq("discord_id", discordId)
    .order("play_count", { ascending: false });
  return data || [];
}

export async function getGuildCrownsLeaderboard(guildId) {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb
    .from("fm_crowns")
    .select("discord_id")
    .eq("guild_id", guildId);
  if (!data) return [];

  const counts = {};
  for (const row of data) {
    counts[row.discord_id] = (counts[row.discord_id] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([discord_id, crown_count]) => ({ discord_id, crown_count }))
    .sort((a, b) => b.crown_count - a.crown_count);
}

// ─── Album index (for /fmwhoknowsalbum + server aggregations) ─────────────────

function albumKey(artistName, albumName) {
  return `${artistName.toLowerCase()}||${albumName.toLowerCase()}`;
}

export async function indexUserAlbums(discordId, albums) {
  const sb = getSupabase();
  if (!sb || !albums.length) return;

  const CHUNK = 200;
  for (let i = 0; i < albums.length; i += CHUNK) {
    const rows = albums.slice(i, i + CHUNK).map(a => ({
      discord_id: discordId,
      artist_name: a.artist?.name || a.artist || "",
      album_name: a.name,
      album_key: albumKey(a.artist?.name || a.artist || "", a.name),
      play_count: parseInt(String(a.playcount)) || 0,
      updated_at: new Date().toISOString(),
    }));
    await sb
      .from("fm_user_albums")
      .upsert(rows, { onConflict: "discord_id,album_key" });
  }
}

export async function getGuildWhoKnowsAlbum(memberIds, artistName, albumName) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];
  const key = albumKey(artistName, albumName);
  const { data } = await sb
    .from("fm_user_albums")
    .select("discord_id, play_count, artist_name, album_name")
    .in("discord_id", memberIds)
    .eq("album_key", key)
    .gt("play_count", 0)
    .order("play_count", { ascending: false });
  return data || [];
}

export async function getServerTopAlbums(memberIds, limit = 10) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];

  const CHUNK = 500;
  const allRows = [];
  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const { data } = await sb
      .from("fm_user_albums")
      .select("album_key, artist_name, album_name, play_count")
      .in("discord_id", memberIds.slice(i, i + CHUNK));
    if (data) allRows.push(...data);
  }

  const totals = new Map();
  for (const r of allRows) {
    const existing = totals.get(r.album_key);
    if (!existing) {
      totals.set(r.album_key, { artist_name: r.artist_name, album_name: r.album_name, total: r.play_count, listeners: 1 });
    } else {
      existing.total += r.play_count;
      existing.listeners++;
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// ─── Track index (for /fmwhoknowstrack + server aggregations) ─────────────────

function trackKey(artistName, trackName) {
  return `${artistName.toLowerCase()}||${trackName.toLowerCase()}`;
}

export async function indexUserTracks(discordId, tracks) {
  const sb = getSupabase();
  if (!sb || !tracks.length) return;

  const CHUNK = 200;
  for (let i = 0; i < tracks.length; i += CHUNK) {
    const rows = tracks.slice(i, i + CHUNK).map(t => ({
      discord_id: discordId,
      artist_name: t.artist?.name || t.artist || "",
      track_name: t.name,
      track_key: trackKey(t.artist?.name || t.artist || "", t.name),
      play_count: parseInt(String(t.playcount)) || 0,
      updated_at: new Date().toISOString(),
    }));
    await sb
      .from("fm_user_tracks")
      .upsert(rows, { onConflict: "discord_id,track_key" });
  }
}

export async function getGuildWhoKnowsTrack(memberIds, artistName, trackName) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];
  const key = trackKey(artistName, trackName);
  const { data } = await sb
    .from("fm_user_tracks")
    .select("discord_id, play_count, artist_name, track_name")
    .in("discord_id", memberIds)
    .eq("track_key", key)
    .gt("play_count", 0)
    .order("play_count", { ascending: false });
  return data || [];
}

export async function getServerTopArtists(memberIds, limit = 10) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];

  const CHUNK = 500;
  const allRows = [];
  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const { data } = await sb
      .from("fm_user_artists")
      .select("artist_name_lower, artist_name, play_count")
      .in("discord_id", memberIds.slice(i, i + CHUNK));
    if (data) allRows.push(...data);
  }

  const totals = new Map();
  for (const r of allRows) {
    const existing = totals.get(r.artist_name_lower);
    if (!existing) {
      totals.set(r.artist_name_lower, { artist_name: r.artist_name, total: r.play_count, listeners: 1 });
    } else {
      existing.total += r.play_count;
      existing.listeners++;
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export async function getServerTopTracks(memberIds, limit = 10) {
  const sb = getSupabase();
  if (!sb || !memberIds.length) return [];

  const CHUNK = 500;
  const allRows = [];
  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const { data } = await sb
      .from("fm_user_tracks")
      .select("track_key, artist_name, track_name, play_count")
      .in("discord_id", memberIds.slice(i, i + CHUNK));
    if (data) allRows.push(...data);
  }

  const totals = new Map();
  for (const r of allRows) {
    const existing = totals.get(r.track_key);
    if (!existing) {
      totals.set(r.track_key, { artist_name: r.artist_name, track_name: r.track_name, total: r.play_count, listeners: 1 });
    } else {
      existing.total += r.play_count;
      existing.listeners++;
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
