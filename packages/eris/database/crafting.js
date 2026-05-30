/**
 * @file packages/eris/database/crafting.js
 * @module packages/eris/database/crafting
 *
 * Per-user discovered crafting recipes. Plain Supabase-backed reads/writes —
 * no economy dependency (coin/ingredient costs are settled by the caller).
 */
import { getSupabase } from "./core.js";
import { log } from "../utils/logger.js";

// ─── CRAFTING / RECIPES ────────────────────────────────────────────────────

export async function getDiscoveredRecipes(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data } = await supabase.from("eris_recipes").select("*").eq("user_id", userId);
    return data || [];
  } catch { return []; }
}

export async function addDiscoveredRecipe(userId, recipeName) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from("eris_recipes").upsert({ user_id: userId, recipe_name: recipeName, discovered_at: new Date().toISOString() });
  } catch (e) { log(`[DB] ${e.message}`); }
}
