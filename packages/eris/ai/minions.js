// ai/minions.js — Minion worker system for passive income
// Users buy minions from the shop, minions earn coins every 30 min automatically.

import { log } from "../utils/logger.js";

const MINION_TYPES = {
  worker: { emoji: "⛏️", baseEarn: [5, 15], description: "earns 5-15 coins every 30 min" },
  miner: { emoji: "💎", baseEarn: [10, 30], description: "earns 10-30 coins every 30 min" },
  thief: { emoji: "🦹", baseEarn: [5, 20], description: "steals 5-20 coins every 30 min (risky)", catchChance: 0.20 },
  farmer: { emoji: "🌾", baseEarn: [8, 20], description: "earns 8-20 coins every 30 min" },
};

// In-memory minion store — loaded from Supabase on init
const _userMinions = new Map(); // userId → { minions: [], maxSlots: 1, pendingEarnings: 0 }

export function getMinionData(userId) {
  if (!_userMinions.has(userId)) _userMinions.set(userId, { minions: [], maxSlots: 1, pendingEarnings: 0 });
  return _userMinions.get(userId);
}

export function hireMinion(userId, type, name) {
  const data = getMinionData(userId);
  if (!MINION_TYPES[type]) return { success: false, error: `unknown minion type: ${type}` };
  if (data.minions.length >= data.maxSlots) return { success: false, error: `all ${data.maxSlots} slots full — buy a Minion Slot from the shop` };
  // Clamp user-supplied names to 50 chars so an abusive 500-char name can't
  // bloat storage or produce weirdly-wrapped Discord messages.
  const safeName = (name || `${type} #${data.minions.length + 1}`).toString().slice(0, 50).trim();
  const minion = { type, name: safeName || `${type} #${data.minions.length + 1}`, hiredAt: Date.now(), totalEarned: 0 };
  data.minions.push(minion);
  _save();
  return { success: true, minion };
}

export function upgradeSlots(userId) {
  const data = getMinionData(userId);
  if (data.maxSlots >= 5) return { success: false, error: "max 5 slots" };
  data.maxSlots++;
  _save();
  return { success: true, newMax: data.maxSlots };
}

export function renameMinion(userId, index, newName) {
  const data = getMinionData(userId);
  if (!data.minions[index]) return { success: false, error: "no minion at that slot" };
  data.minions[index].name = newName;
  _save();
  return { success: true };
}

export function collectEarnings(userId) {
  const data = getMinionData(userId);
  const amount = Math.floor(data.pendingEarnings);
  data.pendingEarnings = 0;
  _save();
  return amount;
}

export function getMinionStatus(userId) {
  const data = getMinionData(userId);
  return {
    minions: data.minions.map((m, i) => ({
      slot: i,
      type: m.type,
      name: m.name,
      emoji: MINION_TYPES[m.type]?.emoji || "👤",
      description: MINION_TYPES[m.type]?.description || "",
      totalEarned: m.totalEarned,
    })),
    maxSlots: data.maxSlots,
    pendingEarnings: Math.floor(data.pendingEarnings),
    slotsUsed: data.minions.length,
  };
}

// Called by the background timer every 30 minutes
export function tickAllMinions() {
  let totalEarned = 0;
  let caughtThieves = 0;
  for (const [userId, data] of _userMinions) {
    for (const minion of data.minions) {
      const type = MINION_TYPES[minion.type];
      if (!type) continue;
      const base = type.baseEarn[0] + Math.floor(Math.random() * (type.baseEarn[1] - type.baseEarn[0] + 1));
      if (minion.type === "thief" && Math.random() < (type.catchChance || 0.20)) {
        // Thief got caught — clamp penalty so it can't silently exceed earnings.
        // Old `Math.max(0, ...)` swallowed the under-cap penalty, leaving thieves
        // with no actual downside risk.
        const penalty = Math.min(Math.floor(base * 0.5), data.pendingEarnings || 0);
        data.pendingEarnings = (data.pendingEarnings || 0) - penalty;
        caughtThieves++;
        continue;
      }
      data.pendingEarnings += base;
      minion.totalEarned += base;
      totalEarned += base;
    }
  }
  if (totalEarned > 0) _save();
  return { totalEarned, caughtThieves, usersWithMinions: _userMinions.size };
}

// Track consecutive save failures so we surface a sustained outage instead of
// silently losing minion earnings across a Supabase blip.
let _saveFailures = 0;
async function _save() {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("bot_data").upsert({ id: "eris_minions", data: Object.fromEntries(_userMinions) });
    if (_saveFailures > 0) {
      log(`[MINIONS] save recovered after ${_saveFailures} failures`);
      _saveFailures = 0;
    }
  } catch (err) {
    _saveFailures++;
    if (_saveFailures === 1 || _saveFailures % 5 === 0) {
      log(`[MINIONS] save failed (${_saveFailures} consecutive): ${err.message}`);
    }
  }
}

// Load minion data with shape validation — corrupt rows used to crash downstream
// in hireMinion/tickAllMinions instead of being skipped cleanly.
function _validMinionRow(d) {
  return d && typeof d === "object"
    && Array.isArray(d.minions)
    && (d.maxSlots == null || typeof d.maxSlots === "number")
    && (d.pendingEarnings == null || typeof d.pendingEarnings === "number");
}

// Load on startup
(async () => {
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return;
    const { data: row } = await sb.from("bot_data").select("data").eq("id", "eris_minions").single();
    if (row?.data) {
      let skipped = 0;
      for (const [uid, d] of Object.entries(row.data)) {
        if (!_validMinionRow(d)) { skipped++; continue; }
        _userMinions.set(uid, d);
      }
      log(`[MINIONS] Loaded ${_userMinions.size} users with minions${skipped ? ` (${skipped} corrupt rows skipped)` : ""}`);
    }
  } catch {}
})();
