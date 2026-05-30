/**
 * @file packages/irene/database/access.js
 * @module irene/database/access
 *
 * Access control: Irene access role, verification gating + public channels,
 * trusted users (with a 5-minute background TTL re-fetch so revocations
 * propagate without a restart), and per-user DM opt-out.
 */

import { data, getSupabase, save, ensureGuild, _markEntity } from "./core.js";
import { log } from "../utils/logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// ACCESS CONTROL — Irene access role, verification gating, trusted users,
// per-user DM opt-out
// ═══════════════════════════════════════════════════════════════════════════

// ─── Irene Access Role ───────────────────────────────────────────────────────

export function setAccessRole(guildId, roleId) {
  ensureGuild(guildId).irene_access_role_id = roleId;
  save("guild_settings");
}

// ─── Verification Role ──────────────────────────────────────────────────────
// The "verified" role gates access to most channels. Unverified users can only
// see channels explicitly marked as public (rules, verification, etc.)

export function setVerificationRole(guildId, roleId) {
  ensureGuild(guildId).verification_role_id = roleId;
  save("guild_settings");
}

export function getVerificationRole(guildId) {
  return data.guild_settings[guildId]?.verification_role_id ?? null;
}

export function getPublicChannels(guildId) {
  return data.guild_settings[guildId]?.public_channels ?? [];
}

export function setPublicChannels(guildId, channelIds) {
  ensureGuild(guildId).public_channels = channelIds;
  save("guild_settings");
}

// ─── Trusted Users ───────────────────────────────────────────────────────────
// Users added here get full admin-level access to Irene's tools, same as server admins.
//
// The bot loads `data` once at boot, so without a refresh path the cache goes
// stale the moment a trusted user is revoked via direct DB edit, a sister
// shard, or any process other than this one. The risk is asymmetric:
// granting trust is fine to lag (worst case: a legit user waits a moment),
// but *revoking* trust must propagate or a recently-removed user retains
// admin-level tool access until the next restart.
//
// We can't make getTrustedUsers async without rewriting every call site, so
// we use a sync read with a background TTL-driven re-fetch: a stale cache
// triggers a fire-and-forget refresh that updates `data.guild_settings`.
// Subsequent reads see the fresh value.

const TRUSTED_TTL_MS = 5 * 60 * 1000; // 5 min — short enough to bound stale-trust window
const _trustedFetchedAt = new Map(); // guildId → epoch ms of last refresh
const _trustedRefreshInFlight = new Map(); // guildId → Promise (dedup concurrent refreshes)

async function _refreshTrustedUsers(guildId) {
  const supabase = getSupabase();
  if (!supabase) return;
  if (_trustedRefreshInFlight.has(guildId)) return _trustedRefreshInFlight.get(guildId);
  const p = (async () => {
    try {
      const { data: row, error } = await supabase
        .from("bot_data")
        .select("data")
        .eq("id", "irene")
        .single();
      if (error || !row?.data?.guild_settings) return;
      const fresh = row.data.guild_settings?.[guildId]?.trusted_users ?? [];
      const current = ensureGuild(guildId);
      // Replace only the trusted_users slice — leave everything else alone so
      // we don't clobber in-flight local writes to other fields.
      current.trusted_users = fresh;
      _trustedFetchedAt.set(guildId, Date.now());
    } catch (err) {
      log(`[DB] Trusted-user refresh failed for ${guildId}: ${err.message}`);
    } finally {
      _trustedRefreshInFlight.delete(guildId);
    }
  })();
  _trustedRefreshInFlight.set(guildId, p);
  return p;
}

export function getTrustedUsers(guildId) {
  const lastFetch = _trustedFetchedAt.get(guildId) || 0;
  if (Date.now() - lastFetch > TRUSTED_TTL_MS) {
    // Mark optimistically so back-to-back stale reads only kick off one refresh.
    _trustedFetchedAt.set(guildId, Date.now());
    // Fire-and-forget — current call returns whatever's in the cache; the next
    // call after the network round-trip will see the refreshed value.
    _refreshTrustedUsers(guildId).catch(() => {});
  }
  return data.guild_settings[guildId]?.trusted_users ?? [];
}

export function addTrustedUser(guildId, userId) {
  const s = ensureGuild(guildId);
  const list = s.trusted_users ?? [];
  if (!list.includes(userId)) {
    s.trusted_users = [...list, userId];
    // Local write is authoritative — defer the next TTL refresh so we don't
    // immediately race ourselves before the save("guild_settings") flush completes.
    _trustedFetchedAt.set(guildId, Date.now());
    save("guild_settings");
  }
}

export function removeTrustedUser(guildId, userId) {
  const s = data.guild_settings[guildId];
  if (!s?.trusted_users) return;
  s.trusted_users = s.trusted_users.filter((id) => id !== userId);
  _trustedFetchedAt.set(guildId, Date.now());
  _markEntity("guild_settings", guildId);
  save("guild_settings");
}

// ─── DM Opt-Out ──────────────────────────────────────────────────────────────
// Per-user preference — if opted out, Irene won't DM them anything

export function isDmOptout(userId) {
  return data.dm_optout?.includes(userId) ?? false;
}

export function setDmOptout(userId, optout) {
  if (!data.dm_optout) data.dm_optout = [];
  if (optout) {
    if (!data.dm_optout.includes(userId)) {
      data.dm_optout.push(userId);
      save("dm_optout");
    }
  } else {
    data.dm_optout = data.dm_optout.filter((id) => id !== userId);
    save("dm_optout");
  }
}
