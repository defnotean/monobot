/**
 * @file packages/irene/database/personality.js
 * @module irene/database/personality
 *
 * Personality instructions — Supabase-synced so the dashboard editor and the
 * bot share one source of truth (irene_personality table, id="irene"). NOT
 * part of the in-memory cache; every read/write is a direct round-trip.
 */

import { getSupabase } from "./core.js";

// ═══════════════════════════════════════════════════════════════════════════
// PERSONALITY (Supabase-synced) — editable from the dashboard
// ═══════════════════════════════════════════════════════════════════════════

export async function getPersonality() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: row } = await supabase.from("irene_personality").select("instructions").eq("id", "irene").single();
  return row?.instructions || null;
}

export async function updatePersonality(instructions) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("irene_personality").upsert({ id: "irene", instructions });
  return !error;
}
