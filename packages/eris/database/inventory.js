/**
 * @file packages/eris/database/inventory.js
 * @module packages/eris/database/inventory
 *
 * Shop catalog (with atomic optimistic-locked stock decrement / increment),
 * per-user item inventory, and the unique-key achievements table. No economy
 * dependency — coin debits for purchases happen in the caller, this module only
 * moves item rows. Imports the Supabase client from core.
 */
import { getSupabase } from "./core.js";
import { log } from "../utils/logger.js";

// ─── SHOP ───────────────────────────────────────────────────────────────────

export async function getShopItems(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_shop_items").select("*").or(`guild_id.eq.${guildId},guild_id.is.null`).order("price");
  return data || [];
}

export async function addShopItem(guildId, item) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_shop_items").insert({ guild_id: guildId, ...item }); } catch (e) { log(`[DB] ${e.message}`); }
}

export async function decrementShopStock(itemId) {
  // Back-compat wrapper — forwards to the atomic version and ignores the result.
  await tryDecrementShopStock(itemId);
}

/**
 * Atomically decrement shop stock iff it's still > 0. Uses optimistic locking:
 * reads the current stock, then conditionally updates only if the value hasn't
 * changed. Two parallel buyers for the last copy can't both succeed — one of
 * them gets { ok: false, reason: "stock_changed" } and the caller must refund.
 * Returns { ok: true, remaining } or { ok: false, reason }.
 */
export async function tryDecrementShopStock(itemId) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "offline" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: row, error: readErr } = await supabase
        .from("eris_shop_items")
        .select("limited_stock")
        .eq("id", itemId)
        .single();
      if (readErr) return { ok: false, reason: readErr.message };
      if (row?.limited_stock == null) return { ok: true, remaining: null }; // unlimited
      if (row.limited_stock <= 0) return { ok: false, reason: "sold_out" };

      const newStock = row.limited_stock - 1;
      const { data: updated, error: writeErr } = await supabase
        .from("eris_shop_items")
        .update({ limited_stock: newStock })
        .eq("id", itemId)
        .eq("limited_stock", row.limited_stock) // optimistic — only if still matches
        .select("id");
      if (writeErr) return { ok: false, reason: writeErr.message };
      if (updated?.length) return { ok: true, remaining: newStock };
      // Conflict — someone else bought between our read and write. Retry.
    } catch (e) { log(`[DB] tryDecrementShopStock: ${e.message}`); }
  }
  return { ok: false, reason: "stock_changed_retry_exhausted" };
}

/**
 * Atomically increment shop stock by 1. Used when a purchase fails after
 * stock was reserved — previously we wrote back a stale pre-decrement
 * value which could over-restore if other buyers moved the number in between.
 */
export async function tryIncrementShopStock(itemId) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "offline" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: row, error: readErr } = await supabase
        .from("eris_shop_items")
        .select("limited_stock")
        .eq("id", itemId)
        .single();
      if (readErr) return { ok: false, reason: readErr.message };
      if (row?.limited_stock == null) return { ok: true, remaining: null }; // unlimited — nothing to refund

      const newStock = row.limited_stock + 1;
      const { data: updated, error: writeErr } = await supabase
        .from("eris_shop_items")
        .update({ limited_stock: newStock })
        .eq("id", itemId)
        .eq("limited_stock", row.limited_stock)
        .select("id");
      if (writeErr) return { ok: false, reason: writeErr.message };
      if (updated?.length) return { ok: true, remaining: newStock };
    } catch (e) { log(`[DB] tryIncrementShopStock: ${e.message}`); }
  }
  return { ok: false, reason: "stock_changed_retry_exhausted" };
}

// ─── INVENTORY ──────────────────────────────────────────────────────────────

export async function getInventory(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_inventory").select("*").eq("user_id", userId).order("acquired_at", { ascending: false });
  return data || [];
}

export async function addToInventory(userId, itemName, itemType) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_inventory").insert({ user_id: userId, item_name: itemName, item_type: itemType }); } catch (e) { log(`[DB] ${e.message}`); }
}

// Removes one matching row and returns its original item_type (or null) so
// callers that re-grant the item later — e.g. auction escrow refunds — can
// restore it under the same inventory category instead of a lifecycle string.
export async function removeFromInventory(userId, itemName) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_inventory").select("id, item_type").eq("user_id", userId).eq("item_name", itemName).limit(1).single();
    if (data) {
      await supabase.from("eris_inventory").delete().eq("id", data.id);
      return data.item_type ?? null;
    }
  } catch (e) { log(`[DB] ${e.message}`); }
  return null;
}

export async function hasItem(userId, itemName) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data } = await supabase.from("eris_inventory").select("id").eq("user_id", userId).eq("item_name", itemName).limit(1);
  return (data?.length ?? 0) > 0;
}

// ─── ACHIEVEMENTS ───────────────────────────────────────────────────────────

export async function unlockAchievement(userId, key) {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("eris_achievements").insert({ user_id: userId, achievement_key: key });
    return !error; // returns false if already unlocked (unique constraint)
  } catch { return false; }
}

export async function getUnlockedAchievements(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("eris_achievements").select("achievement_key, unlocked_at").eq("user_id", userId);
  return data || [];
}

export async function hasAchievement(userId, key) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data } = await supabase.from("eris_achievements").select("id").eq("user_id", userId).eq("achievement_key", key).limit(1);
  return (data?.length ?? 0) > 0;
}
