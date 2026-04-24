// ─── Weekly Server Digest ───────────────────────────────────────────────────
// Aggregates last-7d activity into a single embed and posts it to a configured
// channel (setGuildSetting `digest_channel_id`). Runs Sunday 12 PM local.
//
// Irene doesn't log every message to Supabase (conversations are truncated in
// memory), so the digest focuses on bump ROI + growth, which ARE persisted
// in irene_bumps + irene_bump_joins.
//
// Degrades silently if Supabase tables are missing.

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { getSupabase, getGuildSettings, setGuildSetting } from "../database.js";
import { log } from "../utils/logger.js";

const BUMPS_TABLE = "irene_bumps";
const BUMP_JOINS_TABLE = "irene_bump_joins";

// Guard against concurrent tick overlap (long outages -> slow loops) and
// against re-firing within the same noon hour for a guild already posted.
let _tickInFlight = false;
const _postedThisWeek = new Set(); // key: `${guildId}:${YYYY-WW}`

function _weekKey(d = new Date()) {
  // Pseudo ISO-week key — good enough for dedup within the same noon window.
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  const week = Math.floor(dayOfYear / 7);
  return `${year}-${String(week).padStart(2, "0")}`;
}

function _clampField(value, max = 1024) {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Build the digest payload for a guild. Returns null if no data worth posting.
 */
export async function buildDigest(guild, { days = 7 } = {}) {
  const sb = getSupabase();
  if (!sb) return null;

  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [bumpsRes, joinsRes] = await Promise.allSettled([
    sb.from(BUMPS_TABLE).select("service, bumped_at").eq("guild_id", guild.id).gte("bumped_at", cutoffIso),
    sb.from(BUMP_JOINS_TABLE).select("minutes_since_bump, joined_at").eq("guild_id", guild.id).gte("joined_at", cutoffIso),
  ]);

  const bumps = bumpsRes.status === "fulfilled" ? (bumpsRes.value.data || []) : [];
  const bumpCount = bumps.length;
  const serviceCounts = new Map();
  for (const b of bumps) {
    const svc = b.service || "unknown";
    serviceCounts.set(svc, (serviceCounts.get(svc) || 0) + 1);
  }
  let topService = null;
  let topServiceCount = 0;
  for (const [svc, count] of serviceCounts) {
    if (count > topServiceCount) { topService = svc; topServiceCount = count; }
  }

  const joins = joinsRes.status === "fulfilled" ? (joinsRes.value.data || []) : [];
  const totalJoins = joins.length;
  const postBumpJoins = joins.filter(j => typeof j.minutes_since_bump === "number" && j.minutes_since_bump >= 0 && j.minutes_since_bump <= 15).length;
  const avgJoinsPerBump = bumpCount ? Math.round((postBumpJoins / bumpCount) * 100) / 100 : 0;

  const memberCount = guild.memberCount ?? guild.approximateMemberCount ?? 0;

  if (bumpCount === 0 && totalJoins === 0) return null;

  const title = `✨ ${String(guild.name || "server").slice(0, 80)} — weekly digest`;
  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle(title.slice(0, 256))
    .setDescription(`a look back at the last ${days} days`)
    .setTimestamp();

  if (bumpCount > 0) {
    const bumpLines = [`**${bumpCount}** bumps`];
    if (topService) bumpLines.push(`top: ${topService} (${topServiceCount})`);
    if (totalJoins > 0) bumpLines.push(`**${postBumpJoins}** joins within 15m of a bump`);
    if (avgJoinsPerBump > 0) bumpLines.push(`~${avgJoinsPerBump} joins / bump`);
    embed.addFields({ name: "🚀 Bump ROI", value: _clampField(bumpLines.join("\n")), inline: true });
  }

  if (totalJoins > 0) {
    embed.addFields({ name: "👋 Growth", value: _clampField(`**${totalJoins}** new members this week`), inline: true });
  }

  embed.addFields({ name: "👥 Members", value: _clampField(`**${memberCount.toLocaleString()}** total`), inline: true });

  return embed;
}

/**
 * Post the digest to the configured channel for a guild.
 * Sets `digest_last_posted_at` BEFORE sending so a transient channel failure
 * doesn't cause the tick loop to re-fire within the same noon hour.
 */
export async function postDigest(guild, client, opts = {}) {
  const gs = getGuildSettings(guild.id);
  const channelId = gs?.digest_channel_id;
  if (!channelId) return { posted: false, reason: "no digest channel configured" };

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { posted: false, reason: "digest channel unreachable" };
  // Cross-guild leak guard — channel must belong to the current guild.
  if (channel.guild?.id && channel.guild.id !== guild.id) {
    return { posted: false, reason: "channel belongs to a different guild" };
  }

  const me = guild.members.me;
  const perms = channel.permissionsFor?.(me);
  if (!perms?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ViewChannel])) {
    return { posted: false, reason: "missing Send/Embed/View permission in digest channel" };
  }

  const embed = await buildDigest(guild, opts);
  if (!embed) return { posted: false, reason: "no activity to report" };

  // Stamp BEFORE the send so even a transient failure won't spam retries
  // within the same 12:xx window.
  try {
    const r = setGuildSetting(guild.id, "digest_last_posted_at", Date.now());
    if (r && typeof r.then === "function") await r;
  } catch {}

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    return { posted: false, reason: `discord send failed: ${err?.message || err}` };
  }
  return { posted: true };
}

/**
 * Cron tick — call from ready.js. Fires on Sunday between 12:00 and 12:59 local
 * time for each guild with a configured digest channel, once per week.
 */
export async function weeklyDigestTick(client) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const now = new Date();
    if (now.getDay() !== 0) return; // Sunday only
    if (now.getHours() !== 12) return; // noon window

    const wk = _weekKey(now);
    for (const guild of client.guilds.cache.values()) {
      try {
        const gs = getGuildSettings(guild.id);
        if (!gs?.digest_channel_id) continue;
        const key = `${guild.id}:${wk}`;
        if (_postedThisWeek.has(key)) continue;
        const lastAt = Number(gs.digest_last_posted_at) || 0;
        if (Math.abs(Date.now() - lastAt) < 6 * 24 * 60 * 60 * 1000) {
          _postedThisWeek.add(key);
          continue;
        }
        _postedThisWeek.add(key);
        const result = await postDigest(guild, client);
        if (result.posted) log(`[Digest] Posted weekly digest for ${guild.name}`);
        else log(`[Digest] Skip ${guild.name}: ${result.reason}`);
      } catch (e) {
        log(`[Digest] ${guild.name}: ${e.message}`);
      }
    }
    // Prune stale week keys (keep only the current week)
    for (const k of _postedThisWeek) {
      if (!k.endsWith(wk)) _postedThisWeek.delete(k);
    }
  } finally {
    _tickInFlight = false;
  }
}
