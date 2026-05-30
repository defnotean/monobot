/**
 * @file packages/eris/database/social.js
 * @module packages/eris/database/social
 *
 * The bot's emotional state (mood / energy) and per-user affinity scores —
 * both in-memory, mutated through the shared `data` cache and debounced to
 * Supabase via core's `save()`. Also tool-usage analytics, the aggregate
 * dashboard counters, the long-poll watch subscriptions (price / news / deploy)
 * + recent dream log, and the UNIFIED cross-twin server whitelist (canonical
 * store bot_data row id="main", written through the atomic RPC helpers).
 */
import { getSupabase, data, save } from "./core.js";
import { log } from "../utils/logger.js";

// ─── MOOD (in-memory + debounced sync) ───
export function getMood() {
  return { ...data.mood };
}

export function updateMood(score, energy) {
  data.mood.mood_score = Math.max(-100, Math.min(100, score));
  data.mood.energy = Math.max(0, Math.min(100, energy));
  save("mood");
}

export function shiftMood(delta, energyDelta = 0) {
  updateMood(data.mood.mood_score + delta, data.mood.energy + energyDelta);
}

// ─── RELATIONSHIPS (in-memory + debounced sync) ───
export function getRelationship(userId) {
  return data.relationships[userId] || { affinity_score: 0, interactions_count: 0 };
}

export function updateRelationship(userId, affinityDelta) {
  const current = getRelationship(userId);
  data.relationships[userId] = {
    affinity_score: Math.max(-100, Math.min(100, current.affinity_score + affinityDelta)),
    interactions_count: current.interactions_count + 1,
  };
  save("relationships");
}

export async function getAllRelationships() {
  const supabase = getSupabase();
  // Merge in-memory (always latest) with Supabase (persisted)
  const merged = {};

  // Load from Supabase first (baseline)
  if (supabase) {
    const { data: rows } = await supabase.from("eris_relationships").select("*").order("affinity_score", { ascending: false });
    for (const r of (rows || [])) merged[r.user_id] = r;
  }

  // Override with in-memory data (always fresher)
  for (const [uid, r] of Object.entries(data.relationships)) {
    merged[uid] = { user_id: uid, ...r };
  }

  return Object.values(merged).sort((a, b) => b.affinity_score - a.affinity_score);
}

// ─── ANALYTICS ───
export async function logToolUsage(toolName, userId, channelId) {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.from("eris_analytics").insert({ tool_name: toolName, user_id: userId, channel_id: channelId });
}

export async function getAnalytics(days = 7) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: rows } = await supabase.from("eris_analytics").select("*").gte("created_at", since).order("created_at", { ascending: false });
  return rows || [];
}

// ─── DASHBOARD STATS ───
export async function getDashboardStats() {
  const supabase = getSupabase();
  if (!supabase) return { messages: 0, users: 0, commands: 0, channels: 0 };
  try {
    const { count: msgCount } = await supabase.from("eris_memories").select("*", { count: "exact", head: true });
    const { data: users } = await supabase.from("eris_memories").select("user_id").eq("is_bot", false);
    const uniqueUsers = new Set((users || []).map(u => u.user_id)).size;
    const { data: channels } = await supabase.from("eris_memories").select("channel_id");
    const uniqueChannels = new Set((channels || []).map(c => c.channel_id)).size;
    const { count: cmdCount } = await supabase.from("eris_analytics").select("*", { count: "exact", head: true });
    return { messages: msgCount || 0, users: uniqueUsers, commands: cmdCount || 0, channels: uniqueChannels };
  } catch { return { messages: 0, users: 0, commands: 0, channels: 0 }; }
}

// ─── PRICE WATCHES ───
export async function addPriceWatch(userId, channelId, url, productName, targetPrice) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_price_watches").insert({ user_id: userId, channel_id: channelId, url, product_name: productName, target_price: targetPrice });
  return !error;
}
/**
 * Fetch a SINGLE user's price watches. `userId` is REQUIRED and scopes the query
 * to that user — both the `check_prices` and `unwatch_price` tools pass
 * `message.author.id`, so a missing/empty id must return [] rather than leaking
 * every user's watches (their URLs, product names, target prices) cross-user.
 * The `removePriceWatch` delete is already `.eq("user_id", userId)`-scoped, so
 * scoping the read here closes the matching read-side leak.
 * @param {string} userId Discord user id whose watches to return. Required.
 * @returns {Promise<import("./core.js").Row[]>}
 */
export async function getPriceWatches(userId) {
  const supabase = getSupabase();
  if (!supabase || !userId) return [];
  const { data: rows } = await supabase.from("eris_price_watches").select("*").eq("user_id", userId);
  return rows || [];
}
export async function removePriceWatch(userId, id) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_price_watches").delete().eq("id", id).eq("user_id", userId);
  return !error;
}

// ─── NEWS WATCHES ───
export async function addNewsWatch(userId, channelId, topic) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_news_watches").insert({ user_id: userId, channel_id: channelId, topic });
  return !error;
}
export async function getNewsWatches() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_news_watches").select("*");
  return rows || [];
}
export async function removeNewsWatch(userId, id) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_news_watches").delete().eq("id", id).eq("user_id", userId);
  return !error;
}

// ─── DREAMS ───
export async function getRecentDreams(limit = 3) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("eris_dreams")
    .select("content, mood_context, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(10, limit)));
  return data || [];
}

export async function saveDream(content, moodContext) {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.from("eris_dreams").insert({ content, mood_context: moodContext });
}

// ─── DEPLOY WATCHES ───
export async function addDeployWatch(service, projectId, channelId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("eris_deploy_watches").insert({ service, project_id: projectId, channel_id: channelId });
  return !error;
}
export async function getDeployWatches() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: rows } = await supabase.from("eris_deploy_watches").select("*");
  return rows || [];
}

// ─── SHARED WHITELIST (canonical store: bot_data row id="main") ───
// UNIFIED whitelist — both twins (Eris + Irene) read and write the SAME
// bot_data:main row (data.server_whitelist) via the atomic bot_whitelist_add/
// remove RPCs, so the two bots can never drift. Irene's matching helpers live
// in packages/irene/database.js.
export async function getWhitelist() {
  const supabase = getSupabase();
  if (!supabase) { log(`[WHITELIST] getWhitelist: supabase not configured`); return {}; }
  const { data: row, error } = await supabase.from("bot_data").select("data").eq("id", "main").single();
  if (error && error.code !== "PGRST116") {
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
    name: info.name || "Unknown",
    icon_url: info.icon_url || null,
    members: info.members || null,
    invited_by: info.invited_by || null,
    added_at: new Date().toISOString(),
  };
  // Atomic single-key merge (migration 007). Both twins write the shared
  // bot_data:main blob (auto-track on every boot + whitelist_server), so a
  // read-modify-write upsert here races and silently loses entries — a
  // manually-whitelisted server gets clobbered by the other bot's next
  // auto-track, and the gatekeep then evicts the bot on invite. The RPC mutates
  // one jsonb path in a single statement so concurrent writers can't collide.
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

export async function removeFromWhitelist(guildId) {
  const supabase = getSupabase();
  if (!supabase) { log(`[WHITELIST] removeFromWhitelist: supabase not configured`); return false; }
  // Atomic single-key delete (migration 007) — same race rationale as addToWhitelist.
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
