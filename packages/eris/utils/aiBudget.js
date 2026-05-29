// ─── packages/eris/utils/aiBudget.js ────────────────────────────────────────
// OPT-IN daily AI-call ceiling. A chatty user or a small raid shouldn't be
// able to drive unbounded Gemini/Voyage spend, so an operator can set a
// per-user and/or per-guild daily cap. Counters are in-memory and reset at
// the UTC day rollover.
//
// DEFAULT-OFF: caps come from env (AI_DAILY_USER_CAP / AI_DAILY_GUILD_CAP).
// When unset / 0 / non-numeric the cap is treated as unlimited, so behavior
// is bit-identical to today unless an operator opts in. checkBudget() early
// returns in that case — zero allocation, zero Map writes on the hot path.
//
// Pure + injectable clock so the UTC rollover and Map eviction are unit
// testable without waiting a real day.

// counts: key ("user:<id>" | "guild:<id>") → { day: <utcDayNumber>, count }
// The `day` field is how we both reset (different day → start at 0) and evict
// (a rollover sweep drops every entry whose day is not the current day), so
// the Map never accumulates stale entries past a single UTC day.
const _counts = new Map();

// One-time-per-window notice de-dup. key ("user:<id>" | "guild:<id>") →
// utcDayNumber we last notified for. Keeps us from spamming the user a "you've
// hit the limit" line on every subsequent dropped message in the same day.
const _notified = new Map();

// Injectable clock (test-only). Defaults to real wall time.
let _now = () => Date.now();
export function _setClock(fn) { _now = typeof fn === "function" ? fn : () => Date.now(); }
export function _reset() { _counts.clear(); _notified.clear(); _lastSweepDay = -1; _setClock(null); }
// Test-only introspection — proves the Maps don't leak across days.
export function _countSize() { return _counts.size; }
export function _notifySize() { return _notified.size; }

// Whole UTC days since the epoch — changes exactly at 00:00:00 UTC.
function utcDay(ms) { return Math.floor(ms / 86_400_000); }

function readCap(name) {
  const raw = process.env[name];
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 / NaN / negative → unlimited
}

// Are any caps configured? When neither is set the gate is a pure pass-through.
export function budgetEnabled() {
  return readCap("AI_DAILY_USER_CAP") > 0 || readCap("AI_DAILY_GUILD_CAP") > 0;
}

// Drop stale entries from a Map on UTC day rollover so it can't leak. We sweep
// lazily (only when we touch the module) and only when the day actually changed.
let _lastSweepDay = -1;
function sweep(today) {
  if (today === _lastSweepDay) return;
  _lastSweepDay = today;
  for (const [k, v] of _counts) { if (v.day !== today) _counts.delete(k); }
  for (const [k, day] of _notified) { if (day !== today) _notified.delete(k); }
}

function currentCount(key, today) {
  const entry = _counts.get(key);
  if (!entry || entry.day !== today) return 0; // new day → effectively reset
  return entry.count;
}

/**
 * Pure check — would this message's user/guild be over the daily cap if it
 * proceeded to an AI call? Does NOT increment. Cheap early-return when no cap
 * is configured (the default), so the hot path is untouched for operators who
 * never opt in.
 *
 * @param {{ userId?: string, guildId?: string|null }} ids
 * @returns {{ exceeded: true, scope: "user"|"guild" } | { exceeded: false, scope: null }}
 */
export function checkBudget({ userId, guildId } = {}) {
  const userCap = readCap("AI_DAILY_USER_CAP");
  const guildCap = readCap("AI_DAILY_GUILD_CAP");
  if (!userCap && !guildCap) return { exceeded: false, scope: null };

  const today = utcDay(_now());
  sweep(today);

  if (userCap && userId) {
    if (currentCount(`user:${userId}`, today) >= userCap) return { exceeded: true, scope: "user" };
  }
  if (guildCap && guildId) {
    if (currentCount(`guild:${guildId}`, today) >= guildCap) return { exceeded: true, scope: "guild" };
  }
  return { exceeded: false, scope: null };
}

/**
 * Increment the counters for a message that is actually proceeding to an AI
 * call. No-op when no cap is configured. Mirrors the scopes checkBudget reads.
 *
 * @param {{ userId?: string, guildId?: string|null }} ids
 */
export function incrementBudget({ userId, guildId } = {}) {
  const userCap = readCap("AI_DAILY_USER_CAP");
  const guildCap = readCap("AI_DAILY_GUILD_CAP");
  if (!userCap && !guildCap) return;

  const today = utcDay(_now());
  sweep(today);

  if (userCap && userId) bump(`user:${userId}`, today);
  if (guildCap && guildId) bump(`guild:${guildId}`, today);
}

function bump(key, today) {
  const entry = _counts.get(key);
  if (!entry || entry.day !== today) _counts.set(key, { day: today, count: 1 });
  else entry.count++;
}

/**
 * One-time-per-UTC-day notice de-dup. Returns true the FIRST time it's asked
 * for a given scope+id today (so the caller may send a short "daily limit
 * reached" line), false thereafter — same quiet/cooldown spirit as the rest of
 * the gating gauntlet, so we never spam the channel on every dropped message.
 *
 * @param {"user"|"guild"} scope
 * @param {string|null|undefined} id
 * @returns {boolean}
 */
export function shouldNotify(scope, id) {
  if (!id) return false;
  const today = utcDay(_now());
  sweep(today);
  const key = `${scope}:${id}`;
  if (_notified.get(key) === today) return false;
  _notified.set(key, today);
  return true;
}
