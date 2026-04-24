// ─── Bump Analytics ─────────────────────────────────────────────────────────
// Leaderboard + streak + top-bumper queries against the eris_bumps table.
//
// Schema expected:
//   CREATE TABLE eris_bumps (
//     id           bigserial PRIMARY KEY,
//     guild_id     text NOT NULL,
//     user_id      text NOT NULL,
//     service      text NOT NULL DEFAULT 'disboard',
//     rank         integer,
//     bumped_at    timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX eris_bumps_guild_idx ON eris_bumps (guild_id, bumped_at DESC);
//   CREATE INDEX eris_bumps_user_idx  ON eris_bumps (user_id, bumped_at DESC);
//
// If the table doesn't exist, every function degrades silently (returns []
// or 0) so the bump reminder keeps working on servers that haven't migrated.

import { log } from "../utils/logger.js";

// ─── recordBump ─────────────────────────────────────────────────────────────

export async function recordBump({ guildId, userId, service = "disboard", rank = null, atMs = Date.now() }) {
  if (!guildId || !userId) return { ok: false };
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return { ok: false, error: "no supabase" };
    const { error } = await sb.from("eris_bumps").insert({
      guild_id: guildId,
      user_id: userId,
      service,
      rank,
      bumped_at: new Date(atMs).toISOString(),
    });
    if (error) {
      // Table missing / schema mismatch — not fatal; analytics just won't
      // populate until the migration runs.
      log(`[BumpAnalytics] insert failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    log(`[BumpAnalytics] recordBump: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── getBumpLeaderboard ─────────────────────────────────────────────────────

export async function getBumpLeaderboard(guildId, { periodDays = null, limit = 10, service = null } = {}) {
  if (!guildId) return [];
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return [];

    let q = sb.from("eris_bumps").select("user_id, service, bumped_at").eq("guild_id", guildId);
    if (service) q = q.eq("service", service);
    if (periodDays != null) {
      const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
      q = q.gte("bumped_at", cutoff);
    }
    const { data, error } = await q.order("bumped_at", { ascending: false }).limit(2000);
    if (error) { log(`[BumpAnalytics] leaderboard: ${error.message}`); return []; }

    // Tally by user
    const counts = new Map();
    for (const row of data || []) {
      counts.set(row.user_id, (counts.get(row.user_id) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([user_id, count]) => ({ user_id, count }));
  } catch (e) {
    log(`[BumpAnalytics] getBumpLeaderboard: ${e.message}`);
    return [];
  }
}

// ─── getLastBumper ─────────────────────────────────────────────────────────

export async function getLastBumper(guildId, service = null) {
  if (!guildId) return null;
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return null;
    let q = sb.from("eris_bumps").select("user_id, service, bumped_at").eq("guild_id", guildId);
    if (service) q = q.eq("service", service);
    const { data, error } = await q.order("bumped_at", { ascending: false }).limit(1);
    if (error) return null;
    return data?.[0] || null;
  } catch {
    return null;
  }
}

// ─── getGuildStreak ────────────────────────────────────────────────────────
// "Streak" = consecutive days with at least one bump from this service in
// the guild. Caps at 60 to avoid scanning forever.

export async function getGuildStreak(guildId, service = null) {
  if (!guildId) return 0;
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return 0;
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    let q = sb.from("eris_bumps").select("bumped_at").eq("guild_id", guildId).gte("bumped_at", cutoff);
    if (service) q = q.eq("service", service);
    const { data, error } = await q.order("bumped_at", { ascending: false });
    if (error || !data?.length) return 0;

    // Day-level dedupe then count consecutive days backward from today/yesterday.
    const days = new Set();
    for (const row of data) days.add(row.bumped_at.slice(0, 10));

    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) streak++;
      else if (i > 0) break;  // gap after first day: stop
      // i==0 is "today"; if today has no bump yet, keep going — yesterday
      // still counts as a streak.
    }
    return streak;
  } catch {
    return 0;
  }
}

// ─── getUserStreak ─────────────────────────────────────────────────────────
// Consecutive days that THIS user has bumped.

export async function getUserStreak(userId, guildId, service = null) {
  if (!userId || !guildId) return 0;
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return 0;
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    let q = sb.from("eris_bumps").select("bumped_at").eq("guild_id", guildId).eq("user_id", userId).gte("bumped_at", cutoff);
    if (service) q = q.eq("service", service);
    const { data, error } = await q.order("bumped_at", { ascending: false });
    if (error || !data?.length) return 0;

    const days = new Set(data.map(r => r.bumped_at.slice(0, 10)));
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) streak++;
      else if (i > 0) break;
    }
    return streak;
  } catch {
    return 0;
  }
}

// ─── getBumpCount ──────────────────────────────────────────────────────────
// Simple count for a user in a guild over an optional period.

export async function getBumpCount(userId, guildId, { periodDays = null, service = null } = {}) {
  if (!userId || !guildId) return 0;
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return 0;
    let q = sb.from("eris_bumps").select("id", { count: "exact", head: true }).eq("guild_id", guildId).eq("user_id", userId);
    if (service) q = q.eq("service", service);
    if (periodDays != null) {
      const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
      q = q.gte("bumped_at", cutoff);
    }
    const { count, error } = await q;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

// ─── getBumpsPerDay ─────────────────────────────────────────────────────────
// For rank-trend charts — returns array of { day, count } for the last N days.

export async function getBumpsPerDay(guildId, days = 14, service = null) {
  if (!guildId) return [];
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return [];
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let q = sb.from("eris_bumps").select("bumped_at").eq("guild_id", guildId).gte("bumped_at", cutoff);
    if (service) q = q.eq("service", service);
    const { data, error } = await q.order("bumped_at", { ascending: true });
    if (error) return [];

    const tally = new Map();
    for (const row of data || []) {
      const day = row.bumped_at.slice(0, 10);
      tally.set(day, (tally.get(day) || 0) + 1);
    }
    // Fill missing days with 0
    const out = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ day: key, count: tally.get(key) || 0 });
    }
    return out;
  } catch {
    return [];
  }
}
