/**
 * @file packages/irene/database/whitelist.js
 * @module irene/database/whitelist
 *
 * Server whitelist (UNIFIED — canonical store is bot_data:main).
 *
 * Both twins (Eris AND Irene) share ONE server whitelist living in the
 * bot_data row id="main" under data.server_whitelist. Irene used to keep its
 * own copy in the id="irene" blob (data.server_whitelist), which silently
 * drifted from Eris's. These helpers now read/write the SAME canonical row as
 * packages/eris/database.js, mutating it through the atomic bot_whitelist_add /
 * bot_whitelist_remove RPCs (migrations/007_atomic_whitelist.sql) so concurrent
 * writers from either bot can't clobber each other's entries. Reads come
 * straight off bot_data:main.data.server_whitelist. Irene no longer persists a
 * server_whitelist copy in its own blob (see _PERSISTED_SLICES / save snapshot).
 *
 * All four helpers are async (a DB round-trip per read/write) — every caller
 * (events/guildCreate.js, events/ready.js, ai/executor.js) already runs in an
 * async context. This mirrors the Eris implementation exactly.
 */

import { getSupabase } from "./core.js";
import { log } from "../utils/logger.js";

export async function getWhitelist() {
  const supabase = getSupabase();
  if (!supabase) { log(`[WHITELIST] getWhitelist: supabase not configured`); return {}; }
  const { data: row, error } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (error && error.code !== "PGRST116") { // PGRST116 = no rows found
    log(`[WHITELIST] getWhitelist failed: ${error.message} (code=${error.code})`);
    return {};
  }
  return row?.data?.server_whitelist || {};
}

export async function isWhitelisted(guildId) {
  const wl = await getWhitelist();
  return !!wl[guildId];
}

export async function addToWhitelist(guildId, info) {
  const supabase = getSupabase();
  if (!supabase) { log(`[WHITELIST] addToWhitelist: supabase not configured`); return false; }
  const entry = {
    name:       info.name       ?? "Unknown",
    icon_url:   info.icon_url   ?? null,
    members:    info.members    ?? null,
    invited_by: info.invited_by ?? null,
    added_at:   new Date().toISOString(),
  };
  // Atomic single-key merge (migration 007). Both twins write the shared
  // bot_data:main blob (auto-track on every boot + whitelist_server), so a
  // read-modify-write upsert here races and silently loses entries. The RPC
  // mutates one jsonb path in a single statement so concurrent writers can't
  // collide. Mirrors packages/eris/database.js#addToWhitelist.
  const { error: rpcErr } = await supabase.rpc("bot_whitelist_add", { p_guild_id: guildId, p_info: entry });
  if (!rpcErr) return true;
  log(`[WHITELIST] bot_whitelist_add RPC unavailable (${rpcErr.message}) — falling back to read-modify-write`);
  // Fallback (pre-migration-007): whole-blob read-modify-write (lossy under concurrency).
  const { data: row, error: selectErr } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (selectErr && selectErr.code !== "PGRST116") {
    log(`[WHITELIST] addToWhitelist select failed: ${selectErr.message} (code=${selectErr.code})`);
    return false;
  }
  const botData = row?.data || {};
  if (!botData.server_whitelist) botData.server_whitelist = {};
  botData.server_whitelist[guildId] = entry;
  const { error: upsertErr } = await supabase.from("bot_data").upsert({ id: "main", data: botData });
  if (upsertErr) {
    log(`[WHITELIST] addToWhitelist upsert failed for ${guildId}: ${upsertErr.message} (code=${upsertErr.code})`);
    return false;
  }
  return true;
}

// Removes from the shared canonical store (bot_data:main). Atomic single-key
// delete via migration 007; mirrors packages/eris/database.js#removeFromWhitelist.
export async function removeFromWhitelist(guildId) {
  const supabase = getSupabase();
  if (!supabase) { log(`[WHITELIST] removeFromWhitelist: supabase not configured`); return false; }
  const { error: rpcErr } = await supabase.rpc("bot_whitelist_remove", { p_guild_id: guildId });
  if (!rpcErr) return true;
  log(`[WHITELIST] bot_whitelist_remove RPC unavailable (${rpcErr.message}) — falling back to read-modify-write`);
  const { data: row, error: selectErr } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (selectErr && selectErr.code !== "PGRST116") {
    log(`[WHITELIST] removeFromWhitelist select failed: ${selectErr.message} (code=${selectErr.code})`);
    return false;
  }
  const botData = row?.data || {};
  if (botData.server_whitelist?.[guildId]) {
    delete botData.server_whitelist[guildId];
    const { error: upsertErr } = await supabase.from("bot_data").upsert({ id: "main", data: botData });
    if (upsertErr) {
      log(`[WHITELIST] removeFromWhitelist upsert failed for ${guildId}: ${upsertErr.message} (code=${upsertErr.code})`);
      return false;
    }
  }
  return true;
}
