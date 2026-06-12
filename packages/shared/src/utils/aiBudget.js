// @ts-nocheck -- shared singleton/factory keeps test-only hooks untyped; bot suites cover behavior.
// OPT-IN daily AI-call ceiling. The factory keeps counters isolated per bot
// while sharing the exact budget algorithm.

function utcDay(ms) {
  return Math.floor(ms / 86_400_000);
}

function readCap(name) {
  const raw = process.env[name];
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function createAiBudget() {
  const counts = new Map();
  const notified = new Map();
  let now = () => Date.now();
  let lastSweepDay = -1;

  function _setClock(fn) {
    now = typeof fn === "function" ? fn : () => Date.now();
  }

  function _reset() {
    counts.clear();
    notified.clear();
    lastSweepDay = -1;
    _setClock(null);
  }

  function _countSize() {
    return counts.size;
  }

  function _notifySize() {
    return notified.size;
  }

  function budgetEnabled() {
    return readCap("AI_DAILY_USER_CAP") > 0 || readCap("AI_DAILY_GUILD_CAP") > 0;
  }

  function sweep(today) {
    if (today === lastSweepDay) return;
    lastSweepDay = today;
    for (const [key, value] of counts) {
      if (value.day !== today) counts.delete(key);
    }
    for (const [key, day] of notified) {
      if (day !== today) notified.delete(key);
    }
  }

  function currentCount(key, today) {
    const entry = counts.get(key);
    if (!entry || entry.day !== today) return 0;
    return entry.count;
  }

  function checkBudget({ userId, guildId } = {}) {
    const userCap = readCap("AI_DAILY_USER_CAP");
    const guildCap = readCap("AI_DAILY_GUILD_CAP");
    if (!userCap && !guildCap) return { exceeded: false, scope: null };

    const today = utcDay(now());
    sweep(today);

    if (userCap && userId && currentCount(`user:${userId}`, today) >= userCap) {
      return { exceeded: true, scope: "user" };
    }
    if (guildCap && guildId && currentCount(`guild:${guildId}`, today) >= guildCap) {
      return { exceeded: true, scope: "guild" };
    }
    return { exceeded: false, scope: null };
  }

  function bump(key, today) {
    const entry = counts.get(key);
    if (!entry || entry.day !== today) counts.set(key, { day: today, count: 1 });
    else entry.count++;
  }

  function incrementBudget({ userId, guildId } = {}) {
    const userCap = readCap("AI_DAILY_USER_CAP");
    const guildCap = readCap("AI_DAILY_GUILD_CAP");
    if (!userCap && !guildCap) return;

    const today = utcDay(now());
    sweep(today);

    if (userCap && userId) bump(`user:${userId}`, today);
    if (guildCap && guildId) bump(`guild:${guildId}`, today);
  }

  function shouldNotify(scope, id) {
    if (!id) return false;
    const today = utcDay(now());
    sweep(today);
    const key = `${scope}:${id}`;
    if (notified.get(key) === today) return false;
    notified.set(key, today);
    return true;
  }

  return {
    _setClock,
    _reset,
    _countSize,
    _notifySize,
    budgetEnabled,
    checkBudget,
    incrementBudget,
    shouldNotify,
  };
}

const singleton = createAiBudget();
export const _setClock = singleton._setClock;
export const _reset = singleton._reset;
export const _countSize = singleton._countSize;
export const _notifySize = singleton._notifySize;
export const budgetEnabled = singleton.budgetEnabled;
export const checkBudget = singleton.checkBudget;
export const incrementBudget = singleton.incrementBudget;
export const shouldNotify = singleton.shouldNotify;
// @ts-nocheck -- shared singleton/factory keeps test-only hooks untyped; bot suites cover behavior.
