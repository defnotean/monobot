// ─── Stock Market ──────────────────────────────────────────────────────────
// Fictional tickers with simulated price drift. Every ~15min each ticker's
// price moves via geometric Brownian motion (μ=0, σ=ticker volatility),
// clamped to ±20% per tick to prevent wild swings. History of last ~96 ticks
// (24h) kept for % change display.
//
// State lives in bot_data key "eris_stocks" — tickers + user portfolios +
// lastTick. Persists across restarts; tick logic is idempotent on startup
// (catches up if bot was offline).

import { log } from "../utils/logger.js";

const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const HISTORY_LEN = 96;                  // 24h of 15-min ticks
const MAX_PCT_PER_TICK = 0.20;           // ±20% clamp
const PRICE_FLOOR = 1;
const PRICE_CEIL = 1_000_000;

// 10 tickers — playful fictional names, varied volatility and starting prices.
const TICKERS_SEED = {
  MEME: { name: "Memestocks Inc",       volatility: 0.06, startPrice: 120 },
  GOLD: { name: "Gold Futures",         volatility: 0.010, startPrice: 1800 },
  ERIS: { name: "Eris Labs",            volatility: 0.03, startPrice: 250 },
  CHAOS:{ name: "Chaos Industries",     volatility: 0.08, startPrice: 50 },
  BUMP: { name: "BumpCo",               volatility: 0.04, startPrice: 200 },
  PETZ: { name: "Petz R Us",            volatility: 0.025, startPrice: 180 },
  FISH: { name: "Ocean Harvest",        volatility: 0.02, startPrice: 90 },
  MOON: { name: "Moonshot Rockets",     volatility: 0.10, startPrice: 400 },
  BANK: { name: "First National Bank",  volatility: 0.005, startPrice: 500 },
  LOOT: { name: "Lootbox Holdings",     volatility: 0.05, startPrice: 75 },
};

let _state = null;
let _loadPromise = null;
let _saveTimer = null;
let _tickInProgress = false;
let _stockRpcAvailable = true;
let _portfolioTableAvailable = true;
const MAX_POSITION_VALUE = 1e12; // Cap holdings × price to stay well under MAX_SAFE_INTEGER

function _freshState() {
  const tickers = {};
  for (const [sym, cfg] of Object.entries(TICKERS_SEED)) {
    tickers[sym] = {
      name: cfg.name,
      volatility: cfg.volatility,
      price: cfg.startPrice,
      basePrice: cfg.startPrice,
      history: [cfg.startPrice],
    };
  }
  return { tickers, portfolios: {}, lastTick: Date.now() };
}

async function _load() {
  if (_state) return _state;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (!sb) { _state = _freshState(); return _state; }
      const { data } = await sb.from("bot_data").select("data").eq("id", "eris_stocks").single();
      const stored = data?.data;
      if (stored && typeof stored === "object") {
        // Validate each ticker shape — fall back to seed if corrupt
        const fresh = _freshState();
        const tickers = {};
        const storedTickers = (stored.tickers && typeof stored.tickers === "object") ? stored.tickers : {};
        for (const [sym, cfg] of Object.entries(TICKERS_SEED)) {
          const t = storedTickers[sym];
          if (
            t && typeof t === "object" &&
            typeof t.price === "number" && Number.isFinite(t.price) && t.price > 0 &&
            typeof t.basePrice === "number" && Number.isFinite(t.basePrice) && t.basePrice > 0 &&
            typeof t.volatility === "number" && Number.isFinite(t.volatility) &&
            Array.isArray(t.history) && t.history.every(p => typeof p === "number" && Number.isFinite(p))
          ) {
            tickers[sym] = {
              name: cfg.name,
              volatility: cfg.volatility,
              price: t.price,
              basePrice: cfg.startPrice,
              history: t.history.slice(-HISTORY_LEN),
            };
          } else {
            tickers[sym] = { ...fresh.tickers[sym] };
          }
        }
        const portfolios = (stored.portfolios && typeof stored.portfolios === "object" && !Array.isArray(stored.portfolios))
          ? stored.portfolios : {};
        const lastTick = (typeof stored.lastTick === "number" && Number.isFinite(stored.lastTick)) ? stored.lastTick : Date.now();
        _state = { tickers, portfolios, lastTick };
        log(`[Stocks] Loaded ${Object.keys(_state.tickers).length} tickers, ${Object.keys(_state.portfolios).length} portfolios`);
      } else {
        _state = _freshState();
      }
    } catch (err) {
      log(`[Stocks] Load failed: ${err.message}`);
      _state = _freshState();
    }
    return _state;
  })();
  try { return await _loadPromise; }
  finally { _loadPromise = null; }
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try {
      const { getSupabase } = await import("../database.js");
      const sb = getSupabase();
      if (!sb || !_state) return;
      await sb.from("bot_data").upsert({ id: "eris_stocks", data: _state });
    } catch (err) {
      log(`[Stocks] Save failed: ${err.message}`);
    }
  }, 2000);
}

function _isMissingDbObject(error) {
  return error?.code === "PGRST202" || error?.code === "42P01" || /Could not find|does not exist|schema cache/i.test(error?.message || "");
}

function _normalizePortfolioRows(rows) {
  const portfolio = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const sym = String(row?.symbol || "").toUpperCase();
    const shares = Math.floor(Number(row?.shares) || 0);
    if (/^[A-Z0-9_]{1,16}$/.test(sym) && shares > 0) portfolio[sym] = shares;
  }
  return portfolio;
}

async function _getPortfolioFromDb(userId) {
  if (!_portfolioTableAvailable) return null;
  try {
    const { getSupabase } = await import("../database.js");
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await sb
      .from("eris_stock_portfolios")
      .select("symbol,shares")
      .eq("user_id", userId);
    if (error) {
      if (_isMissingDbObject(error)) {
        _portfolioTableAvailable = false;
        log("[Stocks] eris_stock_portfolios not deployed — using legacy JSON portfolios. Apply migrations/012_atomic_stock_portfolios_rpc.sql for cross-process trade safety.");
        return null;
      }
      throw new Error(error.message || "portfolio query failed");
    }
    return _normalizePortfolioRows(data);
  } catch (err) {
    log(`[Stocks] Portfolio DB read failed for ${userId}: ${err.message}`);
    return null;
  }
}

async function _tryTradeRpc(name, params) {
  if (!_stockRpcAvailable) return null;
  const { getSupabase } = await import("../database.js");
  const sb = getSupabase();
  if (!sb?.rpc) return null;
  const { data, error } = await sb.rpc(name, params);
  if (error) {
    if (_isMissingDbObject(error)) {
      _stockRpcAvailable = false;
      log("[Stocks] Atomic stock RPCs not deployed — using legacy in-process trade path. Apply migrations/012_atomic_stock_portfolios_rpc.sql for cross-process trade safety.");
      return null;
    }
    return { ok: false, reason: error.message || "stock_rpc_failed" };
  }
  return data || { ok: false, reason: "stock_rpc_empty" };
}

// Box-Muller transform — one sample from N(0,1)
function _randNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function _stepPrice(ticker) {
  const sigma = ticker.volatility;
  // Geometric Brownian motion step with mean-reversion pull toward basePrice
  const meanReversion = 0.02 * Math.log(ticker.basePrice / ticker.price);
  const shock = sigma * _randNormal();
  let pct = meanReversion + shock;
  // Clamp to ±MAX_PCT_PER_TICK
  pct = Math.max(-MAX_PCT_PER_TICK, Math.min(MAX_PCT_PER_TICK, pct));
  const next = Math.max(PRICE_FLOOR, Math.min(PRICE_CEIL, ticker.price * (1 + pct)));
  ticker.price = Math.round(next * 100) / 100; // 2 decimal places
  ticker.history.push(ticker.price);
  if (ticker.history.length > HISTORY_LEN) ticker.history.shift();
}

// Test-only exports of internal helpers. The actual state mutation through
// buyShares/sellShares needs Supabase and withUserLock; these pure slices
// let the test suite pin the bounded-price invariant and share-count
// validation without spinning up the whole DB layer.
export function _testStepPrice(ticker) { return _stepPrice(ticker); }
export function _testParseShareCount(raw) { return _parseShareCount(raw); }
export const _testBounds = { PRICE_FLOOR, PRICE_CEIL, MAX_PCT_PER_TICK, MAX_SHARES_PER_CALL: 1_000_000 };

/**
 * Advance all tickers by however many ticks have elapsed since lastTick.
 * Idempotent: if the bot has been offline for 2 hours, this runs 8 ticks
 * to catch up. Called from ready.js every minute.
 */
export async function stepMarket() {
  if (_tickInProgress) return { ticksFired: 0, busy: true };
  _tickInProgress = true;
  try {
    await _load();
    const now = Date.now();
    const elapsed = now - _state.lastTick;
    if (elapsed < TICK_INTERVAL_MS) return { ticksFired: 0 };

    // Cap catch-up at HISTORY_LEN (24h of 15-min ticks) so a long outage
    // doesn't explode the loop.
    const ticks = Math.min(Math.floor(elapsed / TICK_INTERVAL_MS), HISTORY_LEN);
    // Claim the interval BEFORE running — prevents a slow tick loop from
    // being re-entered if stepMarket is called again mid-run.
    _state.lastTick = now;
    for (let i = 0; i < ticks; i++) {
      for (const sym of Object.keys(_state.tickers)) _stepPrice(_state.tickers[sym]);
    }
    _scheduleSave();
    return { ticksFired: ticks };
  } finally {
    _tickInProgress = false;
  }
}

export async function getMarket() {
  await _load();
  return _state;
}

export async function getPortfolio(userId) {
  await _load();
  const dbPortfolio = await _getPortfolioFromDb(userId);
  if (dbPortfolio) {
    _state.portfolios[userId] = dbPortfolio;
    return dbPortfolio;
  }
  return _state.portfolios[userId] || {};
}

export function getTickerSymbols() {
  return Object.keys(TICKERS_SEED);
}

function _tickerPctChange(ticker, lookback = HISTORY_LEN) {
  const hist = ticker.history;
  if (!hist?.length) return 0;
  const oldPrice = hist[Math.max(0, hist.length - lookback - 1)] || hist[0];
  if (!oldPrice) return 0;
  return ((ticker.price - oldPrice) / oldPrice) * 100;
}

// Strict positive-integer parse — rejects negative/zero/NaN/Infinity and
// clamps max so a hallucinated "buy 999999999 shares" can't blow past
// Number.MAX_SAFE_INTEGER when multiplied by price.
const MAX_SHARES_PER_CALL = 1_000_000;
function _parseShareCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 1) return null;
  if (floored > MAX_SHARES_PER_CALL) return MAX_SHARES_PER_CALL;
  return floored;
}

/**
 * Buy `shares` of `symbol` for the user. Holds withUserLock so rapid
 * buys can't double-spend against the balance. Re-reads the ticker price
 * INSIDE the lock so the cost reflects the current market price at debit
 * time, not some older snapshot.
 */
export async function buyShares(userId, symbol, shares) {
  const sym = String(symbol || "").toUpperCase();
  const n = _parseShareCount(shares);
  if (n === null) return { ok: false, reason: "invalid_share_count" };

  await _load();
  if (!_state.tickers[sym]) {
    return { ok: false, reason: "unknown_ticker", available: Object.keys(_state.tickers) };
  }

  const ticker = _state.tickers[sym];
  const rpcResult = await _tryTradeRpc("eris_buy_stock_shares", {
    p_user_id: userId,
    p_symbol: sym,
    p_shares: n,
    p_price: ticker.price,
    p_max_position_value: MAX_POSITION_VALUE,
  });
  if (rpcResult) {
    if (rpcResult.ok) {
      if (!_state.portfolios[userId]) _state.portfolios[userId] = {};
      _state.portfolios[userId][sym] = Math.floor(Number(rpcResult.newShares) || n);
    }
    return rpcResult;
  }

  const db = await import("../database.js");
  return db.withUserLock(userId, async () => {
    // Re-read inside the lock — price may have ticked since the pre-lock read
    const tickerFresh = _state.tickers[sym];
    if (!tickerFresh) return { ok: false, reason: "unknown_ticker", available: Object.keys(_state.tickers) };
    const cost = Math.ceil(tickerFresh.price * n);
    if (cost <= 0 || !Number.isFinite(cost)) return { ok: false, reason: "price_calc_invalid" };

    // Position cap — prevent accumulated holdings from exceeding safe-int math
    const currentShares = Number(_state.portfolios[userId]?.[sym] || 0);
    const safeCurrent = Number.isFinite(currentShares) && currentShares > 0 ? Math.floor(currentShares) : 0;
    if ((safeCurrent + n) * tickerFresh.price > MAX_POSITION_VALUE) {
      return { ok: false, reason: "position_too_large", maxValue: MAX_POSITION_VALUE };
    }

    // Use the lock-free variant — withUserLock is non-reentrant, so calling
    // tryDeductBalance (which re-acquires) inside would deadlock.
    const deduct = await db.tryDeductBalanceUnsafe(userId, cost, "stock_buy", `${n} ${sym} @ ${tickerFresh.price}`);
    if (!deduct.ok) return { ok: false, reason: deduct.reason, balance: deduct.balance, required: cost };

    if (!_state.portfolios[userId]) _state.portfolios[userId] = {};
    _state.portfolios[userId][sym] = safeCurrent + n;
    _scheduleSave();
    return { ok: true, symbol: sym, shares: n, pricePerShare: tickerFresh.price, totalCost: cost, newBalance: deduct.newBalance, newShares: _state.portfolios[userId][sym] };
  });
}

export async function sellShares(userId, symbol, shares) {
  const sym = String(symbol || "").toUpperCase();
  const n = _parseShareCount(shares);
  if (n === null) return { ok: false, reason: "invalid_share_count" };

  await _load();
  if (!_state.tickers[sym]) return { ok: false, reason: "unknown_ticker", available: Object.keys(_state.tickers) };

  const ticker = _state.tickers[sym];
  const rpcResult = await _tryTradeRpc("eris_sell_stock_shares", {
    p_user_id: userId,
    p_symbol: sym,
    p_shares: n,
    p_price: ticker.price,
  });
  if (rpcResult) {
    if (rpcResult.ok) {
      if (!_state.portfolios[userId]) _state.portfolios[userId] = {};
      const remaining = Math.floor(Number(rpcResult.remainingShares) || 0);
      if (remaining <= 0) delete _state.portfolios[userId][sym];
      else _state.portfolios[userId][sym] = remaining;
    }
    return rpcResult;
  }

  const db = await import("../database.js");
  return db.withUserLock(userId, async () => {
    const tickerFresh = _state.tickers[sym];
    if (!tickerFresh) return { ok: false, reason: "unknown_ticker", available: Object.keys(_state.tickers) };

    const portfolio = _state.portfolios[userId] || {};
    const rawHeld = Number(portfolio[sym] || 0);
    const held = Number.isFinite(rawHeld) && rawHeld > 0 ? Math.floor(rawHeld) : 0;
    if (held < n) return { ok: false, reason: "insufficient_shares", held, requested: n };

    const proceeds = Math.floor(tickerFresh.price * n);
    if (proceeds <= 0 || !Number.isFinite(proceeds)) return { ok: false, reason: "price_calc_invalid" };

    // Decrement FIRST so a crash between credit + decrement can't award free money.
    // If the credit fails below, we rollback.
    const newHeld = held - n;
    if (newHeld <= 0) delete portfolio[sym];
    else portfolio[sym] = newHeld;
    _state.portfolios[userId] = portfolio;

    try {
      // Lock-free — withUserLock is non-reentrant.
      await db.updateBalanceUnsafe(userId, proceeds, "stock_sell", `${n} ${sym} @ ${tickerFresh.price}`);
    } catch (err) {
      // Rollback the decrement
      portfolio[sym] = (portfolio[sym] || 0) + n;
      _state.portfolios[userId] = portfolio;
      return { ok: false, reason: err.message };
    }

    _scheduleSave();
    return { ok: true, symbol: sym, shares: n, pricePerShare: tickerFresh.price, totalProceeds: proceeds, remainingShares: portfolio[sym] || 0 };
  });
}

/**
 * Liquidate portfolio entries for tickers that no longer exist in the
 * current seed. Called opportunistically from buildMarketSummary so users
 * who held shares of a now-removed ticker get their proceeds at the
 * last-known price (or 1 coin/share as a floor) instead of stranded forever.
 */
async function _reconcileOrphanedShares(userId) {
  if (!userId) return;
  const portfolio = _state.portfolios[userId];
  if (!portfolio) return;
  const db = await import("../database.js");
  // Run under the user's lock so a concurrent buy/sell doesn't resurrect the key.
  await db.withUserLock(userId, async () => {
    const p = _state.portfolios[userId];
    if (!p) return;
    for (const [sym, sharesRaw] of Object.entries(p)) {
      if (_state.tickers[sym]) continue;
      const sharesNum = Number(sharesRaw);
      if (!Number.isFinite(sharesNum) || sharesNum <= 0) {
        delete p[sym];
        continue;
      }
      const proceeds = Math.max(1, Math.min(1_000_000, Math.floor(sharesNum)));
      try {
        await db.updateBalanceUnsafe(userId, proceeds, "stock_delisted", `delisted ${sym}`);
        log(`[Stocks] delisted ${sym} for ${userId} — credited ${proceeds} salvage coins`);
      } catch {}
      delete p[sym];
    }
    _scheduleSave();
  });
}

/**
 * Build a snapshot suitable for embedding — tickers with price + 24h change,
 * plus optional user portfolio value.
 */
export async function buildMarketSummary(userId = null) {
  await _load();
  if (userId) {
    try { await _reconcileOrphanedShares(userId); } catch (e) { log(`[Stocks] reconcile failed for ${userId}: ${e.message}`); }
  }
  const rows = Object.entries(_state.tickers).map(([sym, t]) => {
    const pct = _tickerPctChange(t);
    const arrow = pct > 0.5 ? "📈" : pct < -0.5 ? "📉" : "➖";
    return {
      symbol: sym,
      name: t.name,
      price: t.price,
      pct24h: Math.round(pct * 10) / 10,
      arrow,
    };
  }).sort((a, b) => b.pct24h - a.pct24h);

  let portfolio = null;
  if (userId) {
    const p = await getPortfolio(userId);
    const lines = [];
    let total = 0;
    for (const [sym, shares] of Object.entries(p)) {
      const t = _state.tickers[sym];
      if (!t || !shares) continue;
      const value = Math.floor(t.price * shares);
      total += value;
      lines.push({ symbol: sym, shares, pricePerShare: t.price, value });
    }
    portfolio = { lines, totalValue: total };
  }

  return { rows, portfolio, nextTickAt: (_state.lastTick || Date.now()) + TICK_INTERVAL_MS };
}
