/**
 * @file packages/eris/database/games.js
 * @module packages/eris/database/games
 *
 * Per-user game stats (W/L, streaks, totals), in-memory active game sessions
 * (auto-expiring), pending duels, the anonymous confessions queue, trivia
 * stats, and per-user AI preferences. The in-memory session/duel/confession
 * state lives here as module-local Maps/arrays. No economy or inventory
 * dependency — payouts are settled by the caller.
 */
import { getSupabase } from "./core.js";
import { log } from "../utils/logger.js";

// ─── GAME STATS ─────────────────────────────────────────────────────────────

export async function getGameStats(userId, gameType) {
  const supabase = getSupabase();
  if (!supabase) return { wins: 0, losses: 0, current_streak: 0, best_streak: 0, total_wagered: 0, total_won: 0 };
  const { data: row } = await supabase.from("eris_game_stats").select("*").eq("user_id", userId).eq("game_type", gameType).single();
  return row || { wins: 0, losses: 0, current_streak: 0, best_streak: 0, total_wagered: 0, total_won: 0 };
}

export async function recordGameResult(userId, gameType, won, wagered = 0, payout = 0) {
  const supabase = getSupabase();
  if (!supabase) return;
  const stats = await getGameStats(userId, gameType);
  const newStreak = won ? (stats.current_streak > 0 ? stats.current_streak + 1 : 1) : (stats.current_streak < 0 ? stats.current_streak - 1 : -1);
  const bestStreak = Math.max(stats.best_streak || 0, won ? newStreak : 0);
  try {
    await supabase.from("eris_game_stats").upsert({
      user_id: userId, game_type: gameType,
      wins: (stats.wins || 0) + (won ? 1 : 0),
      losses: (stats.losses || 0) + (won ? 0 : 1),
      current_streak: newStreak, best_streak: bestStreak,
      total_wagered: (stats.total_wagered || 0) + wagered,
      total_won: (stats.total_won || 0) + payout,
    });
  } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── ACTIVE GAMES ───────────────────────────────────────────────────────────

const _activeGames = new Map(); // "channelId:userId:gameType" → state

export function saveActiveGame(channelId, userId, gameType, gameState, stake = 0) {
  _activeGames.set(`${channelId}:${userId}:${gameType}`, { gameState, stake, createdAt: Date.now() });
}

export function getActiveGame(channelId, userId, gameType) {
  const key = `${channelId}:${userId}:${gameType}`;
  const game = _activeGames.get(key);
  if (!game) return null;
  // Auto-expire stale games (5 min) — prevents permanently stuck state
  if (Date.now() - game.createdAt > 300_000) {
    _activeGames.delete(key);
    return null;
  }
  return game;
}

export function deleteActiveGame(channelId, userId, gameType) {
  _activeGames.delete(`${channelId}:${userId}:${gameType}`);
}

export function cleanupExpiredGames(maxAgeMs = 180_000) {
  const now = Date.now();
  const expired = [];
  for (const [key, game] of _activeGames) {
    if (now - game.createdAt > maxAgeMs) {
      // key format: "channelId:userId:gameType"
      const [channelId, userId, gameType] = key.split(":");
      expired.push({ channelId, userId, gameType, stake: game.stake });
      _activeGames.delete(key);
    }
  }
  return expired;
}

// ─── DUELS ──────────────────────────────────────────────────────────────────

const _pendingDuels = new Map(); // "channelId:targetId" → duel data

export function createDuel(challengerId, targetId, channelId, stake = 0) {
  const key = `${channelId}:${targetId}`;
  if (_pendingDuels.has(key)) return { success: false, error: "this user already has a pending duel here" };
  _pendingDuels.set(key, { challengerId, targetId, channelId, stake, createdAt: Date.now() });
  return { success: true };
}

export function getPendingDuel(channelId, targetId) {
  return _pendingDuels.get(`${channelId}:${targetId}`) || null;
}

export function resolveDuel(channelId, targetId) {
  const key = `${channelId}:${targetId}`;
  const duel = _pendingDuels.get(key);
  _pendingDuels.delete(key);
  return duel;
}

export function cleanupExpiredDuels(maxAgeMs = 300_000) {
  const now = Date.now();
  for (const [key, duel] of _pendingDuels) {
    if (now - duel.createdAt > maxAgeMs) _pendingDuels.delete(key);
  }
}

// ─── CONFESSIONS ────────────────────────────────────────────────────────────

let _confessionCounter = 0;
const _unpostedConfessions = [];

export async function saveConfession(userId, guildId, channelId, text) {
  const supabase = getSupabase();
  if (!text || text.length > 2000) return false; // Discord embed cap + sanity
  _unpostedConfessions.push({ userId, guildId, channelId, text: text.slice(0, 2000), createdAt: Date.now() });
  if (supabase) {
    try { await supabase.from("eris_confessions").insert({ user_id: userId, guild_id: guildId, channel_id: channelId, confession_text: text }); } catch (e) { log(`[DB] ${e.message}`); }
  }
  return true;
}

export function getUnpostedConfessions() {
  return _unpostedConfessions.splice(0); // drain and return
}

export function getConfessionNumber() {
  return ++_confessionCounter;
}

// ─── TRIVIA STATS ───────────────────────────────────────────────────────────

export async function getTriviaStats(userId) {
  const supabase = getSupabase();
  if (!supabase) return { correct: 0, wrong: 0, current_streak: 0, best_streak: 0 };
  const { data: row } = await supabase.from("eris_trivia").select("*").eq("user_id", userId).single();
  return row || { correct: 0, wrong: 0, current_streak: 0, best_streak: 0 };
}

export async function recordTriviaResult(userId, correct) {
  const supabase = getSupabase();
  if (!supabase) return;
  const stats = await getTriviaStats(userId);
  const newStreak = correct ? (stats.current_streak > 0 ? stats.current_streak + 1 : 1) : 0;
  try {
    await supabase.from("eris_trivia").upsert({
      user_id: userId,
      correct: (stats.correct || 0) + (correct ? 1 : 0),
      wrong: (stats.wrong || 0) + (correct ? 0 : 1),
      current_streak: newStreak,
      best_streak: Math.max(stats.best_streak || 0, newStreak),
    });
  } catch (e) { log(`[DB] ${e.message}`); }
}

// ─── USER PREFERENCES (for smarter AI) ──────────────────────────────────────

export async function getUserPreferences(userId) {
  const supabase = getSupabase();
  if (!supabase) return { topics: [], sentiment_avg: 0, interaction_style: null };
  const { data: row } = await supabase.from("eris_user_preferences").select("*").eq("user_id", userId).single();
  return row || { topics: [], sentiment_avg: 0, interaction_style: null };
}

export async function updateUserPreferences(userId, updates) {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_user_preferences").upsert({ user_id: userId, ...updates, updated_at: new Date().toISOString() }); } catch (e) { log(`[DB] ${e.message}`); }
}
