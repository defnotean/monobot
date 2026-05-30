/**
 * @file packages/eris/database/economy.js
 * @module packages/eris/database/economy
 *
 * The money layer: coin balances with per-user locks (withEconLock), the atomic
 * `eris_add_balance` RPC fast-path with a version-CAS fallback, transfers, daily
 * reward / streak claim, message-earn cooldowns, multi-axis leaderboards, the
 * bank vault (capacity scales with prestige, 1%/day interest), the prestige
 * ladder + earn multipliers, marriage (cached), and weekly/monthly reward
 * claims. Every balance-touching helper serializes on the in-process
 * withEconLock mutex; true cross-process serialization comes from the RPC.
 *
 * Owns the SINGLE economy/bank/marriage caches + the per-user economy lock map.
 * Imports core (client + persistence health), cooldowns (the `_cooldowns` /
 * `_careerTiers` maps the periodic eviction sweep also prunes), and inventory
 * (getMultipliers reads the user's items). One-directional — nothing imports
 * economy in a way that cycles back to it.
 */
import { LRUCache } from "@defnotean/shared/LRUCache";
import { getSupabase, isPersistenceHealthy, _assertPersistenceHealthy } from "./core.js";
import { _cooldowns, _careerTiers } from "./cooldowns.js";
import { getInventory } from "./inventory.js";
import { log } from "../utils/logger.js";

/**
 * @typedef {import("./core.js").Row} Row
 * @typedef {import("./core.js").BalanceError} BalanceError
 */

// ─── ECONOMY ───────────────────────────────────────────────────────────────

const _economyCache = {}; // userId → {balance, daily_streak, last_daily, ...}
const _economyCacheTimes = new Map(); // userId → timestamp of when cached
const ECONOMY_CACHE_TTL = 10_000; // 10 seconds
const _earnCooldown = new Map(); // userId → timestamp
const _economyLocks = new Map(); // userId → Promise (per-user lock to prevent race conditions)

// Periodically evict stale economy cache entries (every 5 minutes)
// Prevents unbounded growth when many unique users interact over time
setInterval(() => {
  const now = Date.now();
  const cutoff = now - ECONOMY_CACHE_TTL * 6; // keep entries up to 60s old
  for (const [uid, ts] of _economyCacheTimes) {
    if (ts < cutoff) {
      _economyCacheTimes.delete(uid);
      delete _economyCache[uid];
    }
  }
  // Evict stale earn cooldowns (>30s old)
  for (const [uid, ts] of _earnCooldown) {
    if (now - ts > 30_000) _earnCooldown.delete(uid);
  }
  // Evict generic per-tool cooldowns older than 2h — past the longest cooldown
  // window (1h rob/pet_train) so the entry can't change any future check, but
  // accumulates one row per (user, tool) forever otherwise.
  for (const [key, ts] of _cooldowns) {
    if (now - ts > 7_200_000) _cooldowns.delete(key);
  }
  // Bound _careerTiers: it's a cumulative per-user count with no timestamp, so
  // we can't expire by staleness without losing progress. Cap the map size and
  // drop the oldest-inserted entries (Map preserves insertion order) — a
  // re-derived count from a fresh entry only costs a user some work-tier bonus
  // they had to re-earn, never coins.
  const CAREER_TIER_MAX = 5000;
  if (_careerTiers.size > CAREER_TIER_MAX) {
    const overflow = _careerTiers.size - CAREER_TIER_MAX;
    let dropped = 0;
    for (const uid of _careerTiers.keys()) {
      if (dropped++ >= overflow) break;
      _careerTiers.delete(uid);
    }
  }
}, 300_000);

/** Acquire a per-user lock for atomic economy operations */
async function withEconLock(userId, fn) {
  // Wait for any previous operation on this user to finish, then run fn()
  // If previous op failed, still proceed (don't block forever)
  const prev = _economyLocks.get(userId) ?? Promise.resolve();
  const current = prev.catch(e => log(`[DB] ${e.message}`)).then(fn);
  _economyLocks.set(userId, current);
  try { return await current; } finally {
    if (_economyLocks.get(userId) === current) _economyLocks.delete(userId);
  }
}

/**
 * Public alias — same lock, semantically used for generic inventory /
 * item operations where "economy" in the name would be misleading. Use
 * this for crafting, loot boxes, item consumption, and any other
 * user-scoped mutation that isn't strictly balance-related.
 */
export async function withUserLock(userId, fn) {
  return withEconLock(userId, fn);
}

export async function getBalance(userId) {
  const supabase = getSupabase();
  // Check cache first (with TTL)
  const cachedAt = _economyCacheTimes.get(userId) || 0;
  if (_economyCache[userId] && (Date.now() - cachedAt < ECONOMY_CACHE_TTL)) return { ..._economyCache[userId] };
  if (!supabase) return { balance: 100, daily_streak: 0, last_daily: null, total_earned: 0, total_lost: 0, total_gambled: 0 };

  try {
    const { data: row } = await supabase.from("eris_economy").select("*").eq("user_id", userId).single();
    if (row) {
      _economyCache[userId] = row;
      _economyCacheTimes.set(userId, Date.now());
      return { ...row };
    }
  } catch (e) {
    log(`[DB] getBalance query failed: ${e.message}`);
    // Return cached or default on Supabase failure
    return _economyCache[userId] ? { ..._economyCache[userId] } : { balance: 100, daily_streak: 0, last_daily: null, total_earned: 0, total_lost: 0, total_gambled: 0 };
  }
  // Initialize new user
  const defaults = { user_id: userId, balance: 100, daily_streak: 0, last_daily: null, total_earned: 0, total_lost: 0, total_gambled: 0, total_stolen: 0, total_stolen_from: 0, last_rob_attempt: null, version: 0 };
  try { await supabase.from("eris_economy").insert(defaults); } catch (e) { log(`[DB] ${e.message}`); }
  _economyCache[userId] = defaults;
  _economyCacheTimes.set(userId, Date.now());
  return { ...defaults };
}

// Tracks whether the `eris_add_balance` RPC is deployed. The first call probes;
// if Postgres reports the function doesn't exist (PGRST202 / "Could not find the function"),
// we flip this to false and never retry — the version-CAS loop below stays the
// fallback path for self-hosters who haven't applied migration 002 yet.
let _rpcAddBalanceAvailable = true;

// Inner balance update — assumes caller already holds withEconLock for userId.
// Do not call directly from outside database.js; use updateBalance() or transferBalance().
//
// Preferred path: the `eris_add_balance` Postgres function (see migration 002)
// does the read-modify-write inside one transaction with SELECT … FOR UPDATE,
// which is a tighter atomicity guarantee than the optimistic-concurrency loop
// below — and it serializes correctly across multiple bot processes, not just
// the in-process withEconLock callers.
//
// Fallback path: if the RPC isn't deployed (or fails for any other reason),
// fall through to the version-CAS retry loop. The semantics are identical
// from the caller's perspective.
async function _updateBalanceUnsafe(userId, delta, type, details) {
  const supabase = getSupabase();
  // Guard at the top — a NaN/Infinity delta corrupts DB + cache.
  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    throw new Error(`invalid balance delta: ${delta}`);
  }

  // ── RPC fast path: one round-trip, server-side atomic ───────────────────
  if (supabase && _rpcAddBalanceAvailable) {
    try {
      const { data: rows, error } = await supabase.rpc("eris_add_balance", {
        p_user_id: userId,
        p_delta: delta,
        p_type: type ?? "other",
        p_details: details ?? "",
      });
      if (error) {
        // PGRST202 = function not found. Disable the RPC path for the rest of
        // the process lifetime so we don't pay this round-trip on every call.
        if (error.code === "PGRST202" || /Could not find the function|does not exist/i.test(error.message || "")) {
          _rpcAddBalanceAvailable = false;
          log(`[DB] eris_add_balance RPC not deployed — falling back to version-CAS path. Apply migrations/002_atomic_balance_rpc.sql to enable atomic updates.`);
        } else {
          // Any other RPC error: fall through to the CAS loop, which has its
          // own retry/recovery logic. Don't permanently disable the RPC for
          // transient errors.
          log(`[DB] eris_add_balance RPC error: ${error.message} — falling back to version-CAS for this call`);
        }
      } else if (Array.isArray(rows) && rows.length === 0) {
        // Empty result set = SQL returned without RETURN NEXT, which means
        // the function refused the update (insufficient balance).
        const current = await getBalance(userId);
        /** @type {BalanceError} */
        const err = new Error("insufficient_balance");
        err.code = "insufficient_balance";
        err.balance = Number(current?.balance) || 0;
        throw err;
      } else if (Array.isArray(rows) && rows.length > 0) {
        const updated = rows[0];
        // Refresh cache from RPC result, preserving streak/daily fields that
        // the RPC doesn't touch (we only fetch the columns it returns).
        const prev = _economyCache[userId] || {};
        _economyCache[userId] = {
          ...prev,
          ...updated,
        };
        _economyCacheTimes.set(userId, Date.now());
        await logTransaction(userId, type, delta, Number(updated.balance) || 0, details);
        return Number(updated.balance) || 0;
      }
    } catch (e) {
      // Re-throw insufficient_balance — that's a contract, not a fallthrough trigger.
      if (e?.code === "insufficient_balance") throw e;
      // Network/transport errors: log and fall through to the CAS loop.
      log(`[DB] eris_add_balance RPC threw: ${e.message} — falling back to version-CAS for this call`);
    }
  }

  // ── Version-CAS fallback (also used when supabase is null) ──────────────
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const current = await getBalance(userId);
    const currentBalance = Number(current.balance) || 0;
    const wouldBe = currentBalance + delta;
    if (wouldBe < 0) {
      // Respect the "never negative" invariant at the API layer so callers
      // see a real error rather than a silent clamp.
      /** @type {BalanceError} */
      const err = new Error("insufficient_balance");
      err.code = "insufficient_balance";
      err.balance = currentBalance;
      throw err;
    }
    const newBalance = wouldBe;

    const updates = { balance: newBalance };
    if (delta > 0) updates.total_earned = (current.total_earned || 0) + delta;
    // Prestige resets intentionally zero out the balance — don't pollute the
    // "most lost" leaderboard with those.
    if (delta < 0 && type !== "prestige") updates.total_lost = (current.total_lost || 0) + Math.abs(delta);
    if (typeof type === "string" && type.startsWith("gamble")) updates.total_gambled = (current.total_gambled || 0) + Math.abs(delta);
    if (type === "rob_success") updates.total_stolen = (current.total_stolen || 0) + delta;
    if (type === "rob_victim") updates.total_stolen_from = (current.total_stolen_from || 0) + Math.abs(delta);

    const currentVersion = current.version || 0;
    updates.version = currentVersion + 1;

    if (supabase) {
      const { error: upsertErr, data: upsertData } = await supabase
        .from("eris_economy")
        .update({ ...updates })
        .eq("user_id", userId)
        .eq("version", currentVersion)
        .select("user_id");

      if (upsertErr) {
        log(`[DB] updateBalance error for ${userId}: ${upsertErr.message}`);
        throw new Error(`db_update_failed: ${upsertErr.message}`);
      }
      if (!upsertData || upsertData.length === 0) {
        // Version conflict — drop cache, back off, retry from the top so we
        // re-check the insufficient-balance invariant against fresh data.
        log(`[DB] updateBalance version conflict for ${userId} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        _economyCacheTimes.delete(userId);
        delete _economyCache[userId];
        if (attempt >= MAX_RETRIES) {
          throw new Error("version_conflict_exhausted");
        }
        // Exponential backoff with jitter to avoid thundering herd
        const wait = 10 * (1 << attempt) + Math.floor(Math.random() * 15);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }
    _economyCache[userId] = { ...current, ...updates };
    _economyCacheTimes.set(userId, Date.now());

    await logTransaction(userId, type, delta, newBalance, details);
    return newBalance;
  }
  throw new Error("version_conflict_exhausted");
}

export async function updateBalance(userId, delta, type = "other", details = "") {
  const supabase = getSupabase();
  // Block economy mutations when the DB is offline — prevents in-memory drift
  // that would silently vanish on next restart.
  if (!supabase) throw new Error("economy_unavailable: database offline");
  // Same refusal once the durable store has been unreachable for too long: a
  // write we can't flush is a write that vanishes on restart.
  _assertPersistenceHealthy();
  return withEconLock(userId, () => _updateBalanceUnsafe(userId, delta, type, details));
}

/**
 * Inner-only updateBalance for callers that ALREADY hold `withUserLock` /
 * `withEconLock` for this user — calling updateBalance (which re-acquires the
 * lock) inside the same lock causes a non-reentrant deadlock. Use this when
 * you've already opened the lock at a higher level (e.g. batch operations,
 * resolveTable payouts, multi-step workflows).
 */
export async function updateBalanceUnsafe(userId, delta, type = "other", details = "") {
  const supabase = getSupabase();
  if (!supabase) throw new Error("economy_unavailable: database offline");
  _assertPersistenceHealthy();
  return _updateBalanceUnsafe(userId, delta, type, details);
}

/**
 * Lock-free tryDeduct — same invariant as `updateBalanceUnsafe`. Use when the
 * caller already holds the user lock.
 */
export async function tryDeductBalanceUnsafe(userId, amount, type = "deduct", details = "") {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  const current = await getBalance(userId);
  if (current.balance < amount) {
    return { ok: false, reason: "insufficient", balance: current.balance, required: amount };
  }
  try {
    const newBalance = await _updateBalanceUnsafe(userId, -amount, type, details);
    return { ok: true, newBalance };
  } catch (err) {
    if (err?.code === "insufficient_balance") {
      return { ok: false, reason: "insufficient", balance: err.balance ?? current.balance };
    }
    throw err;
  }
}

/**
 * Atomic coin transfer between two users — holds both locks (in sorted ID order
 * to avoid deadlock) and verifies sufficient funds inside the lock window.
 * Returns `{ ok: true, newBalance }` on success or `{ ok: false, reason }` on failure.
 * Reasons: "insufficient" | "economy_unavailable" | "self_transfer".
 */
export async function transferBalance(fromId, toId, amount, tax = 0, type = "transfer", details = "") {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (fromId === toId) return { ok: false, reason: "self_transfer" };
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(tax) || tax < 0) {
    return { ok: false, reason: "invalid_amount" };
  }

  const [first, second] = fromId < toId ? [fromId, toId] : [toId, fromId];
  return withEconLock(first, () =>
    withEconLock(second, async () => {
      const sender = await getBalance(fromId);
      const total = Math.floor(amount) + Math.floor(tax);
      if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: "invalid_amount" };
      if (sender.balance < total) {
        return { ok: false, reason: "insufficient", balance: sender.balance, required: total };
      }
      let newSenderBalance;
      try {
        newSenderBalance = await _updateBalanceUnsafe(fromId, -total, type, details || `transfer to ${toId}`);
      } catch (err) {
        return { ok: false, reason: err?.code === "insufficient_balance" ? "insufficient" : err?.message || "debit_failed" };
      }
      try {
        await _updateBalanceUnsafe(toId, Math.floor(amount), "receive", details || `transfer from ${fromId}`);
      } catch (err) {
        // Best-effort rollback — refund sender so coins aren't lost.
        try { await _updateBalanceUnsafe(fromId, total, "transfer_refund", `credit to ${toId} failed`); } catch (rollbackErr) {
          log(`[DB] transferBalance rollback failed for ${fromId}: ${rollbackErr.message} — manual reconciliation needed`);
        }
        return { ok: false, reason: err?.message || "credit_failed" };
      }
      return { ok: true, newBalance: newSenderBalance, sent: amount, tax };
    })
  );
}

export async function claimDaily(userId) {
  const supabase = getSupabase();
  if (!supabase) return { success: false, offline: true };
  // Capture the non-null client so it stays narrowed inside the async closure
  // below (TS can't prove the module-level `supabase` let isn't reassigned across
  // an await; closeDatabase() does null it at shutdown).
  const sb = supabase;
  // Durable store gone dark — refuse rather than stamp a cooldown + credit that
  // can't be flushed. Surfaced to callers as the transient claim_failed message.
  if (!isPersistenceHealthy()) return { success: false, error: "claim_failed" };
  // Serialize the whole read-check-write sequence so rapid /daily spams can't
  // double-claim between the cooldown check and the cache/DB update.
  return withEconLock(userId, async () => {
    const current = await getBalance(userId);
    const now = new Date();
    const lastDaily = current.last_daily ? new Date(current.last_daily) : null;

    if (lastDaily) {
      const hoursSince = (now.getTime() - lastDaily.getTime()) / 3_600_000;
      if (hoursSince < 20) {
        const hoursLeft = Math.ceil(20 - hoursSince);
        return { success: false, hoursLeft };
      }
      if (hoursSince > 48) current.daily_streak = 0;
    }

    const streak = (current.daily_streak || 0) + 1;
    const base = 50;
    const bonus = Math.min(streak * 10, 150);
    const coins = base + bonus;

    try {
      const { data, error } = await sb.rpc("eris_claim_reward", {
        p_user_id: userId,
        p_kind: "daily",
        p_coins: coins,
        p_streak: streak,
        p_cooldown_secs: 20 * 3_600,
        p_now: now.toISOString(),
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { success: false, hoursLeft: 20 };
      if (_economyCache[userId]) {
        _economyCache[userId].balance = Number(row.balance);
        _economyCache[userId].daily_streak = streak;
        _economyCache[userId].last_daily = now.toISOString();
        _economyCache[userId].total_earned = (_economyCache[userId].total_earned || 0) + coins;
      }
      await logTransaction(userId, "daily", coins, Number(row.balance), `streak:${streak}`);
      return { success: true, coins, streak: Number(row.streak ?? streak), bonus, newBalance: Number(row.balance) };
    } catch (e) {
      log(`[DB] claimDaily atomic claim failed (no credit): ${e.message}`);
      return { success: false, error: "claim_failed" };
    }
  });
}

export async function getLeaderboard(limit = 10) {
  const supabase = getSupabase();
  if (!supabase) {
    return Object.entries(_economyCache)
      .map(([uid, e]) => ({ user_id: uid, balance: e.balance }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, limit);
  }
  const { data: rows } = await supabase.from("eris_economy").select("user_id, balance").order("balance", { ascending: false }).limit(limit);
  return rows || [];
}

// ─── Multi-axis leaderboards ───────────────────────────────────────────────
// Supported axes: balance (default), earned, gambled, streak, prestige,
// stolen (rob_success total), lost. The eris_economy schema already has all
// these columns, we just weren't exposing them.
const LEADERBOARD_AXES = {
  balance:  { column: "balance",         label: "💰 Wealthiest",          suffix: "coins" },
  earned:   { column: "total_earned",    label: "📈 Most Earned",         suffix: "coins" },
  gambled:  { column: "total_gambled",   label: "🎰 Biggest Gambler",     suffix: "coins" },
  streak:   { column: "daily_streak",    label: "🔥 Longest Streak",      suffix: "days" },
  prestige: { column: "prestige_level",  label: "⭐ Top Prestige",        suffix: "lv" },
  stolen:   { column: "total_stolen",    label: "🥷 Best Thief",          suffix: "coins" },
  lost:     { column: "total_lost",      label: "💸 Most Lost",           suffix: "coins" },
};

export function getLeaderboardAxes() {
  return Object.keys(LEADERBOARD_AXES);
}

export function getLeaderboardAxisInfo(axis) {
  return LEADERBOARD_AXES[axis] || null;
}

/**
 * @returns {Promise<
 *   { error: string, axis?: undefined, label?: undefined, suffix?: undefined, rows?: undefined }
 *   | { error?: undefined, axis: string, label: string, suffix: string, rows: Array<{ user_id: string, value: number }> }
 * >}
 */
export async function getLeaderboardByAxis(axis, limit = 10) {
  const supabase = getSupabase();
  const info = LEADERBOARD_AXES[axis];
  if (!info) return { error: `unknown axis "${axis}". try: ${Object.keys(LEADERBOARD_AXES).join(", ")}` };

  if (!supabase) {
    // In-memory fallback — only works for the balance axis since other cols
    // live only in Supabase. Return empty for everything else.
    if (axis !== "balance") return { axis, label: info.label, suffix: info.suffix, rows: [] };
    const rows = Object.entries(_economyCache)
      .map(([uid, e]) => ({ user_id: uid, value: e.balance }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
    return { axis, label: info.label, suffix: info.suffix, rows };
  }

  const { data, error } = await supabase
    .from("eris_economy")
    .select(`user_id, ${info.column}`)
    .order(info.column, { ascending: false })
    // Stable tie-breaker — without this, Postgres returns ties in arbitrary
    // order so positions flicker between refreshes.
    .order("user_id", { ascending: true })
    .limit(limit);
  if (error) return { error: error.message };
  // `data` is typed as a ParserError because the select list is built from a
  // dynamic column name (`info.column`) the typed client can't parse statically.
  // The shape is a plain row array at runtime.
  const dataRows = /** @type {Row[]} */ (/** @type {unknown} */ (data) || []);
  const rows = dataRows
    .map((r) => ({ user_id: r.user_id, value: r[info.column] ?? 0 }))
    .filter((r) => r.value > 0); // hide users with no activity on this axis
  return { axis, label: info.label, suffix: info.suffix, rows };
}

export async function logTransaction(userId, type, amount, balanceAfter, details = "") {
  const supabase = getSupabase();
  if (!supabase) return;
  try { await supabase.from("eris_transactions").insert({ user_id: userId, type, amount, balance_after: balanceAfter, details }); } catch (e) { log(`[DB] ${e.message}`); }
}

export function checkEarnCooldown(userId) {
  const last = _earnCooldown.get(userId) || 0;
  if (Date.now() - last < 60_000) return false;
  _earnCooldown.set(userId, Date.now());
  return true;
}

export async function earnMessageCoins(userId) {
  if (!checkEarnCooldown(userId)) return 0;
  const coins = 1 + Math.floor(Math.random() * 3); // 1-3 coins
  await updateBalance(userId, coins, "message_earn", "chatting");
  return coins;
}

// ═══════════════════════════════════════════════════════════════════════════
// BANKING, PRESTIGE, MARRIAGE, REWARDS — bank vault (capacity grows with
// prestige, 1%/day interest), prestige ladder with capped earn multiplier,
// marriage (cached) and weekly/monthly reward claims with streak bonuses.
// All atomic deposits/withdrawals share the economy lock.
// ═══════════════════════════════════════════════════════════════════════════
// ─── BANKING ───────────────────────────────────────────────────────────────

// LRU + 5min TTL: caps memory (1000 distinct users) and lets out-of-band
// Supabase edits propagate within a bounded window instead of being silently
// shadowed by a permanent in-memory copy.
const _bankCache = new LRUCache(1000, 5 * 60_000);
let _rpcBankBalanceAvailable = true;

export async function getBankBalance(userId) {
  const supabase = getSupabase();
  const cached = _bankCache.get(userId);
  if (cached) return { ...cached };
  if (!supabase) return { balance: 0, last_interest: null };
  try {
    const { data } = await supabase.from("eris_bank").select("*").eq("user_id", userId).single();
    if (data) { _bankCache.set(userId, data); return { ...data }; }
  } catch (e) { log(`[DB] ${e.message}`); }
  return { balance: 0, last_interest: null };
}

/**
 * @param {string} userId
 * @param {number} delta
 * @param {{ maxBalance?: number | null }} [options]
 */
export async function updateBankBalance(userId, delta, { maxBalance = null } = {}) {
  const supabase = getSupabase();
  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    throw new Error(`invalid bank delta: ${delta}`);
  }

  if (supabase && _rpcBankBalanceAvailable) {
    try {
      const { data: rows, error } = await supabase.rpc("eris_add_bank_balance", {
        p_user_id: userId,
        p_delta: delta,
        p_max_balance: Number.isFinite(maxBalance) ? maxBalance : null,
      });
      if (error) {
        if (error.code === "PGRST202" || /Could not find the function|does not exist/i.test(error.message || "")) {
          _rpcBankBalanceAvailable = false;
          log(`[DB] eris_add_bank_balance RPC not deployed — falling back to non-atomic bank updates. Apply migrations/009_atomic_bank_rpc.sql to enable cross-process bank safety.`);
        } else {
          log(`[DB] eris_add_bank_balance RPC error: ${error.message} — falling back to non-atomic bank update for this call`);
        }
      } else if (Array.isArray(rows) && rows.length === 0) {
        /** @type {Error & { code?: string }} */
        const err = new Error(delta < 0 ? "insufficient_bank" : "bank_full");
        err.code = err.message;
        throw err;
      } else if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        _bankCache.set(userId, row);
        return Number(row.balance) || 0;
      }
    } catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e);
      if (err?.code === "insufficient_bank" || err?.code === "bank_full") throw err;
      log(`[DB] eris_add_bank_balance RPC threw: ${err?.message || e} — falling back to non-atomic bank update for this call`);
    }
  }

  const current = await getBankBalance(userId);
  const newBal = Math.max(0, current.balance + delta);
  if (typeof maxBalance === "number" && Number.isFinite(maxBalance) && newBal > maxBalance) {
    /** @type {Error & { code?: string }} */
    const err = new Error("bank_full");
    err.code = "bank_full";
    throw err;
  }
  const row = { user_id: userId, balance: newBal, last_interest: current.last_interest || new Date().toISOString() };
  if (supabase) {
    try { await supabase.from("eris_bank").upsert(row); } catch (e) { log(`[DB] ${e.message}`); }
  }
  _bankCache.set(userId, row);
  return newBal;
}

/**
 * Atomic deduct — verifies sufficient funds INSIDE the per-user lock and
 * only debits if the check passes. Use for button-driven purchases where
 * the balance-check and deduct used to be separate `await` calls, letting
 * two rapid clicks both pass the check before either debit landed.
 * Returns { ok: true, newBalance } or { ok: false, reason }.
 */
export async function tryDeductBalance(userId, amount, type = "deduct", details = "") {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  return withEconLock(userId, async () => {
    const current = await getBalance(userId);
    if (current.balance < amount) {
      return { ok: false, reason: "insufficient", balance: current.balance, required: amount };
    }
    const newBalance = await _updateBalanceUnsafe(userId, -amount, type, details);
    return { ok: true, newBalance };
  });
}

/**
 * Atomic wallet → bank transfer. Holds the user's economy lock across
 * read-check-debit-credit so parallel bank_deposit calls can't both
 * pass the "wallet has enough" check and double-spend the wallet.
 * Returns { ok, newWalletBalance, newBankBalance } or { ok: false, reason }.
 */
export async function bankDeposit(userId, amount) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  return withEconLock(userId, async () => {
    const wallet = await getBalance(userId);
    if (wallet.balance < amount) return { ok: false, reason: "insufficient_wallet", balance: wallet.balance };
    const bank = await getBankBalance(userId);
    const cap = await getBankCapacity(userId);
    if (bank.balance + amount > cap) {
      return { ok: false, reason: "bank_full", bank: bank.balance, capacity: cap, maxDeposit: cap - bank.balance };
    }
    // Deduct the source (wallet) FIRST — it throws on failure, so we never
    // credit the bank against a debit that didn't land. If the bank credit
    // then throws, roll the wallet back so coins are conserved.
    const newWalletBalance = await _updateBalanceUnsafe(userId, -amount, "bank_deposit", "deposited to bank");
    let newBankBalance;
    try {
      newBankBalance = await updateBankBalance(userId, amount, { maxBalance: cap });
    } catch (err) {
      try { await _updateBalanceUnsafe(userId, amount, "bank_deposit_refund", "bank credit failed"); } catch (rollbackErr) {
        log(`[DB] bankDeposit rollback failed for ${userId}: ${rollbackErr.message} — manual reconciliation needed`);
      }
      return { ok: false, reason: err?.code === "bank_full" ? "bank_full" : err?.message || "bank_credit_failed", bank: bank.balance, capacity: cap, maxDeposit: cap - bank.balance };
    }
    return { ok: true, newWalletBalance, newBankBalance, capacity: cap };
  });
}

/**
 * Atomic bank → wallet transfer, same safety properties as bankDeposit.
 */
export async function bankWithdraw(userId, amount) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "economy_unavailable" };
  if (!isPersistenceHealthy()) return { ok: false, reason: "economy_unavailable" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  return withEconLock(userId, async () => {
    const bank = await getBankBalance(userId);
    if (bank.balance < amount) return { ok: false, reason: "insufficient_bank", balance: bank.balance };
    // Deduct the source (bank) FIRST, then credit the wallet. If the wallet
    // credit throws, refund the bank so coins are conserved.
    const newBankBalance = await updateBankBalance(userId, -amount);
    let newWalletBalance;
    try {
      newWalletBalance = await _updateBalanceUnsafe(userId, amount, "bank_withdraw", "withdrew from bank");
    } catch (err) {
      try { await updateBankBalance(userId, amount); } catch (rollbackErr) {
        log(`[DB] bankWithdraw rollback failed for ${userId}: ${rollbackErr.message} — manual reconciliation needed`);
      }
      return { ok: false, reason: err?.code === "insufficient_balance" ? "wallet_credit_failed" : err?.message || "wallet_credit_failed" };
    }
    return { ok: true, newWalletBalance, newBankBalance };
  });
}

export async function getBankCapacity(userId) {
  const prestige = await getPrestigeLevel(userId);
  return 5000 + prestige * 2500;
}

export async function applyBankInterest(userId) {
  const supabase = getSupabase();
  // Serialize the read-modify-write so two concurrent calls can't both read the
  // same last_interest, both pass the 24h check, and each credit interest —
  // double-crediting (minting) coins. The last_interest stamp inside the lock
  // makes a second call see hoursSince < 24 and short-circuit.
  return withEconLock(userId, async () => {
    const bank = await getBankBalance(userId);
    if (bank.balance <= 0) return 0;
    const last = bank.last_interest ? new Date(bank.last_interest) : new Date();
    const hoursSince = (Date.now() - last.getTime()) / 3_600_000;
    if (hoursSince < 24) return 0;
    const days = Math.floor(hoursSince / 24);
    const interest = Math.floor(bank.balance * 0.01 * days);
    if (interest <= 0) return 0;
    const cap = await getBankCapacity(userId);
    const actualInterest = Math.min(interest, cap - bank.balance);
    if (actualInterest <= 0) return 0;
    await updateBankBalance(userId, actualInterest);
    const updated = await getBankBalance(userId);
    if (supabase) {
      try { await supabase.from("eris_bank").update({ last_interest: new Date().toISOString() }).eq("user_id", userId); } catch (e) { log(`[DB] ${e.message}`); }
    }
    _bankCache.set(userId, { ...updated, last_interest: new Date().toISOString() });
    return actualInterest;
  });
}

// ─── PRESTIGE ──────────────────────────────────────────────────────────────

export async function getPrestigeLevel(userId) {
  const econ = await getBalance(userId);
  return econ.prestige_level || 0;
}

export async function setPrestigeLevel(userId, level) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from("eris_economy").update({ prestige_level: level }).eq("user_id", userId);
  } catch (e) { log(`[DB] ${e.message}`); }
  if (_economyCache[userId]) _economyCache[userId].prestige_level = level;
}

// Max prestige level applied in the multiplier. Higher raw levels are allowed
// (cosmetic flex) but the earn bonus caps here so runaway compounding doesn't
// turn every earn into an overflow-risking number.
const MAX_PRESTIGE_MULTIPLIER_LEVEL = 50;

export async function getMultipliers(userId) {
  const rawPrestige = await getPrestigeLevel(userId);
  const prestige = Math.min(rawPrestige, MAX_PRESTIGE_MULTIPLIER_LEVEL);
  const marriage = await getMarriage(userId);
  const inv = await getInventory(userId);
  const hasLucky = inv.some(i => i.item_name === "Lucky Charm" && i.active);
  let mult = 1.0;
  const breakdown = [];
  if (prestige > 0) {
    mult += prestige * 0.10;
    const cappedNote = rawPrestige > prestige ? ` (capped, raw lv${rawPrestige})` : "";
    breakdown.push(`prestige lv${prestige}: +${prestige * 10}%${cappedNote}`);
  }
  if (marriage) { mult += 0.10; breakdown.push("married: +10%"); }
  if (hasLucky) { mult += 0.05; breakdown.push("lucky charm: +5%"); }
  return { multiplier: mult, breakdown };
}

// ─── MARRIAGE ──────────────────────────────────────────────────────────────

// LRU + 5min TTL — bounds memory and prevents stale state lingering forever
// after out-of-band DB edits. Writes (createMarriage/deleteMarriage) refresh
// the entry so concurrent readers see the new state immediately.
const _marriageCache = new LRUCache(500, 5 * 60_000);

export async function getMarriage(userId) {
  const supabase = getSupabase();
  if (_marriageCache.has(userId)) return _marriageCache.get(userId);
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_marriages").select("*").or(`user1_id.eq.${userId},user2_id.eq.${userId}`).single();
    _marriageCache.set(userId, data || null);
    return data || null;
  } catch {
    _marriageCache.set(userId, null);
    return null;
  }
}

export async function createMarriage(user1Id, user2Id) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("eris_marriages").insert({ user1_id: user1Id, user2_id: user2Id, married_at: new Date().toISOString() }).select().single();
    // Invalidate-then-refresh both partners so any stale "null" cached during
    // a getMarriage() that ran before the insert is replaced.
    _marriageCache.delete(user1Id);
    _marriageCache.delete(user2Id);
    _marriageCache.set(user1Id, data);
    _marriageCache.set(user2Id, data);
    return data;
  } catch { return null; }
}

export async function deleteMarriage(userId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const marriage = await getMarriage(userId);
  if (!marriage) return false;
  try {
    await supabase.from("eris_marriages").delete().eq("id", marriage.id);
    // Invalidate-then-refresh — same rationale as createMarriage. Set to null
    // so subsequent reads short-circuit without hitting Supabase.
    _marriageCache.delete(marriage.user1_id);
    _marriageCache.delete(marriage.user2_id);
    _marriageCache.set(marriage.user1_id, null);
    _marriageCache.set(marriage.user2_id, null);
    return true;
  } catch { return false; }
}

// ─── WEEKLY / MONTHLY REWARDS ──────────────────────────────────────────────

export async function claimWeekly(userId) {
  const supabase = getSupabase();
  if (!supabase) return { success: false, offline: true };
  const sb = supabase; // narrow non-null across the async closure below
  if (!isPersistenceHealthy()) return { success: false, error: "claim_failed" };
  return withEconLock(userId, async () => {
    const econ = await getBalance(userId);
    const now = new Date();
    const lastWeekly = econ.last_weekly ? new Date(econ.last_weekly) : null;
    if (lastWeekly && (now.getTime() - lastWeekly.getTime()) < 168 * 3_600_000) {
      const hoursLeft = Math.ceil((168 * 3_600_000 - (now.getTime() - lastWeekly.getTime())) / 3_600_000);
      return { success: false, hoursLeft };
    }
    const streak = lastWeekly && (now.getTime() - lastWeekly.getTime()) < 336 * 3_600_000 ? (econ.weekly_streak || 0) + 1 : 1;
    const coins = 500 + streak * 100;
    try {
      const { data, error } = await sb.rpc("eris_claim_reward", {
        p_user_id: userId,
        p_kind: "weekly",
        p_coins: coins,
        p_streak: streak,
        p_cooldown_secs: 168 * 3_600,
        p_now: now.toISOString(),
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { success: false, hoursLeft: 168 };
      if (_economyCache[userId]) {
        _economyCache[userId].balance = Number(row.balance);
        _economyCache[userId].last_weekly = now.toISOString();
        _economyCache[userId].weekly_streak = streak;
        _economyCache[userId].total_earned = (_economyCache[userId].total_earned || 0) + coins;
      }
      await logTransaction(userId, "weekly", coins, Number(row.balance), `streak:${streak}`);
      return { success: true, coins, streak: Number(row.streak ?? streak), newBalance: Number(row.balance) };
    } catch (e) {
      log(`[DB] claimWeekly atomic claim failed (no credit): ${e.message}`);
      return { success: false, error: "claim_failed" };
    }
  });
}

export async function claimMonthly(userId) {
  const supabase = getSupabase();
  if (!supabase) return { success: false, offline: true };
  const sb = supabase; // narrow non-null across the async closure below
  if (!isPersistenceHealthy()) return { success: false, error: "claim_failed" };
  return withEconLock(userId, async () => {
    const econ = await getBalance(userId);
    const now = new Date();
    const lastMonthly = econ.last_monthly ? new Date(econ.last_monthly) : null;
    if (lastMonthly && (now.getTime() - lastMonthly.getTime()) < 720 * 3_600_000) {
      const hoursLeft = Math.ceil((720 * 3_600_000 - (now.getTime() - lastMonthly.getTime())) / 3_600_000);
      return { success: false, hoursLeft };
    }
    const streak = lastMonthly && (now.getTime() - lastMonthly.getTime()) < 1440 * 3_600_000 ? (econ.monthly_streak || 0) + 1 : 1;
    const coins = 5000 + streak * 1000;
    try {
      const { data, error } = await sb.rpc("eris_claim_reward", {
        p_user_id: userId,
        p_kind: "monthly",
        p_coins: coins,
        p_streak: streak,
        p_cooldown_secs: 720 * 3_600,
        p_now: now.toISOString(),
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { success: false, hoursLeft: 720 };
      if (_economyCache[userId]) {
        _economyCache[userId].balance = Number(row.balance);
        _economyCache[userId].last_monthly = now.toISOString();
        _economyCache[userId].monthly_streak = streak;
        _economyCache[userId].total_earned = (_economyCache[userId].total_earned || 0) + coins;
      }
      await logTransaction(userId, "monthly", coins, Number(row.balance), `streak:${streak}`);
      return { success: true, coins, streak: Number(row.streak ?? streak), newBalance: Number(row.balance) };
    } catch (e) {
      log(`[DB] claimMonthly atomic claim failed (no credit): ${e.message}`);
      return { success: false, error: "claim_failed" };
    }
  });
}

// Shared with the games/pets/challenges domains, which need the same in-process
// mutex but not the public `withUserLock` name. Not re-exported by the barrel.
export { withEconLock, _updateBalanceUnsafe };
