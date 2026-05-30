/**
 * @file database.js
 * @module packages/eris/database
 *
 * Eris persistence layer over Supabase with a full in-memory fallback. ALL
 * state for the bot — economy, mood, relationships, facts/memory, games,
 * shop, inventory, achievements, loans, bounties, daily challenges, boss
 * battles, pets, territories, heists, auctions, banking, marriages,
 * crafting, cooldowns, per-guild settings and directives — flows through
 * exported getters/setters in this file. Reads are synchronous from cache;
 * writes mutate cache and queue a debounced flush to Supabase.
 *
 * THIS FILE IS A BARREL. The implementation was split (behavior-preserving)
 * into sibling modules under ./database/ so no single file is a 2000-line
 * god-object. Importers across the repo do `import { x } from "../database.js"`
 * etc. — that keeps working unchanged because this barrel re-exports the exact
 * same public surface (identical names + signatures). The split modules are:
 *   - ./database/core.js          — Supabase client, shared in-memory `data`
 *                                   cache, debounced save()/flush, the
 *                                   flush-failure durability signal, flushAll().
 *                                   Holds the SINGLE instance of every piece of
 *                                   cross-domain state; domains import it, it
 *                                   imports no domain (acyclic).
 *   - ./database/userContent.js   — conversations, personality, server personas,
 *                                   facts/memory, local-commands queue, notes,
 *                                   reminders, snippets.
 *   - ./database/social.js        — mood, relationships, analytics, dashboard,
 *                                   price/news/deploy watches, dreams, the
 *                                   unified cross-twin server whitelist.
 *   - ./database/economy.js       — balances + per-user locks, atomic balance
 *                                   RPC / version-CAS, transfers, daily/weekly/
 *                                   monthly, leaderboards, banking, prestige,
 *                                   marriage, multipliers.
 *   - ./database/inventory.js     — shop (atomic stock), inventory, achievements.
 *   - ./database/games.js         — game stats, active games, duels, confessions,
 *                                   trivia, user preferences.
 *   - ./database/activities.js    — loans, bounties, daily challenges, boss
 *                                   battles, pets + pet battles, territories,
 *                                   heists, auctions, roast battles.
 *   - ./database/crafting.js      — discovered recipes.
 *   - ./database/cooldowns.js     — generic cooldowns, activity streaks, career
 *                                   tiers (pure in-memory maps).
 *   - ./database/guildSettings.js — per-server feature config + directives.
 *
 * Key tables / domains (Supabase prefix `eris_*`, plus the shared
 * `bot_data` key/value blob for guild settings + server personas):
 *   - eris_economy        — balances, daily streak, lifetime totals, version
 *   - eris_memories       — channel-scoped conversation history (no cache)
 *   - eris_facts          — per-user facts with sensitivity (semantic recall)
 *   - eris_mood           — global Eris mood + energy (cache-of-one)
 *   - eris_relationships  — per-user affinity score + interaction count
 *   - eris_reminders      — pending reminders, drained by scheduler
 *   - eris_personality    — editable system-prompt instructions
 *   - eris_inventory / eris_shop / eris_achievements
 *   - eris_loans / eris_bounties / eris_daily_challenges
 *   - eris_boss / eris_pets / eris_territories
 *   - eris_heists / eris_auctions / eris_roast_battles
 *   - eris_bank / eris_prestige / eris_marriages
 *   - bot_data            — guild_settings, server_personas (JSON blobs)
 *   - local_commands      — outbound command queue for remote workers
 *
 * Cache + flush model:
 *   Mutating helpers call `save(bucket)`, which marks the bucket dirty and
 *   schedules a single 200ms debounced flush (`_DEBOUNCE_MS`). The window
 *   is intentionally tight: a hard crash between mutation and flush drops
 *   at most one batching window of writes per bucket. The
 *   `beforeExit` hook (registered once per process) and the SIGTERM /
 *   SIGINT handlers in index.js call `flushAll()`, which clears the
 *   pending timer, re-marks every persistable bucket dirty, and drains
 *   synchronously with a 4-second timeout so a hung Supabase request
 *   cannot block exit forever.
 *
 * Atomic balance RPC vs version-CAS fallback:
 *   `_updateBalanceUnsafe` prefers the `eris_add_balance` Postgres
 *   function (see migrations/002_atomic_balance_rpc.sql), which does the
 *   read-modify-write inside one transaction with `SELECT … FOR UPDATE`
 *   and is the only path that serializes correctly across multiple bot
 *   processes. If the RPC is not deployed (PGRST202), the module flips
 *   `_rpcAddBalanceAvailable = false` and never retries — every later
 *   call drops straight into the version-CAS retry loop (optimistic
 *   concurrency keyed on the row's `version` column from
 *   migrations/001_add_economy_version.sql). The CAS path is correct for
 *   a single-process bot held together by `withEconLock`, but two
 *   processes hitting the same row can still race; apply migration 002
 *   on any multi-process / multi-replica deployment.
 *
 * REQUIRE_PERSISTENCE env var:
 *   Parsed in config.js as `config.requirePersistence` (default off). When
 *   truthy, `initDatabase()` throws hard if Supabase credentials are missing
 *   or all init retries fail — production deploys flip this so silent in-
 *   memory mode never reaches Render (parity with packages/irene/database.js).
 *   `updateBalance` already refuses to mutate when Supabase is offline
 *   (`economy_unavailable: database offline`) regardless of the flag — that
 *   is the load-bearing guard against silent coin loss.
 *
 * In-memory mode caveats:
 *   With Supabase unconfigured (or all init attempts failed), the bot
 *   still boots and serves reads from the in-memory `data` object plus
 *   per-domain Maps, but every byte vanishes on restart: facts, mood,
 *   relationships, reminders, guild settings, server personas, the
 *   in-progress economy/game state — everything. Most economy-mutating
 *   helpers explicitly refuse to run in this mode rather than letting
 *   the cache drift away from a (non-existent) source of truth.
 *
 * Concurrency model:
 *   `withEconLock(userId, fn)` serializes all balance-touching work for
 *   one user across the in-process call sites (transfers, daily claims,
 *   bank deposit/withdraw, weekly/monthly rewards, pet training, loan
 *   repayments). The public alias `withUserLock` is the same mutex and
 *   is the right entry point for non-balance per-user mutations like
 *   crafting and loot boxes. Inner `*Unsafe` helpers
 *   (`updateBalanceUnsafe`, `tryDeductBalanceUnsafe`) skip the
 *   re-acquisition and MUST only be called from inside an existing
 *   `withEconLock` / `withUserLock` block — otherwise concurrent callers
 *   will race the version-CAS loop. The lock is in-process only; true
 *   cross-process serialization for the economy row comes from the
 *   `eris_add_balance` RPC path.
 *
 * Test surface: packages/eris/tests/db/ covers cache lifecycle, economy
 * math, loan-repay races, pet train cooldowns, daily-challenge
 * completion, and bidOnAuction. Tests mock the Supabase client; live DB
 * is never required to run them.
 */

// ─── SETUP, INIT, DEBOUNCED SAVE / FLUSH, SHUTDOWN (database/core.js) ─────────
export {
  initDatabase,
  getSupabase,
  isPersistenceHealthy,
  flushAll,
} from "./database/core.js";

// ─── CONVERSATIONS, PERSONALITY, PERSONAS, FACTS, NOTES, REMINDERS, SNIPPETS ──
export {
  saveInteraction,
  getRecentHistory,
  getPersonality,
  updatePersonality,
  getServerPersona,
  setServerPersona,
  getAllServerPersonas,
  saveFact,
  getFacts,
  pruneExpiredFacts,
  getFactsGlobal,
  deleteFactByText,
  clearAllFacts,
  getFactsFiltered,
  deleteFact,
  queueLocalCommand,
  saveNote,
  getNotes,
  deleteNote,
  searchNotes,
  saveReminder,
  getPendingReminders,
  markReminderDone,
  markRemindersDoneBatch,
  getUserReminders,
  cancelReminder,
  saveSnippet,
  getSnippet,
  listSnippets,
} from "./database/userContent.js";

// ─── MOOD, RELATIONSHIPS, ANALYTICS, DASHBOARD, WATCHES, DREAMS, WHITELIST ────
export {
  getMood,
  updateMood,
  shiftMood,
  getRelationship,
  updateRelationship,
  getAllRelationships,
  logToolUsage,
  getAnalytics,
  getDashboardStats,
  addPriceWatch,
  getPriceWatches,
  removePriceWatch,
  addNewsWatch,
  getNewsWatches,
  removeNewsWatch,
  getRecentDreams,
  saveDream,
  addDeployWatch,
  getDeployWatches,
  getWhitelist,
  isWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
} from "./database/social.js";

// ─── ECONOMY, BANKING, PRESTIGE, MARRIAGE, REWARDS (database/economy.js) ──────
export {
  withUserLock,
  getBalance,
  updateBalance,
  updateBalanceUnsafe,
  tryDeductBalanceUnsafe,
  transferBalance,
  claimDaily,
  getLeaderboard,
  getLeaderboardAxes,
  getLeaderboardAxisInfo,
  getLeaderboardByAxis,
  logTransaction,
  checkEarnCooldown,
  earnMessageCoins,
  getBankBalance,
  updateBankBalance,
  tryDeductBalance,
  bankDeposit,
  bankWithdraw,
  getBankCapacity,
  applyBankInterest,
  getPrestigeLevel,
  setPrestigeLevel,
  getMultipliers,
  getMarriage,
  createMarriage,
  deleteMarriage,
  claimWeekly,
  claimMonthly,
} from "./database/economy.js";

// ─── SHOP, INVENTORY, ACHIEVEMENTS (database/inventory.js) ────────────────────
export {
  getShopItems,
  addShopItem,
  decrementShopStock,
  tryDecrementShopStock,
  tryIncrementShopStock,
  getInventory,
  addToInventory,
  removeFromInventory,
  hasItem,
  unlockAchievement,
  getUnlockedAchievements,
  hasAchievement,
} from "./database/inventory.js";

// ─── GAME STATE, DUELS, CONFESSIONS, TRIVIA, USER PREFS (database/games.js) ───
export {
  getGameStats,
  recordGameResult,
  saveActiveGame,
  getActiveGame,
  deleteActiveGame,
  cleanupExpiredGames,
  createDuel,
  getPendingDuel,
  resolveDuel,
  cleanupExpiredDuels,
  saveConfession,
  getUnpostedConfessions,
  getConfessionNumber,
  getTriviaStats,
  recordTriviaResult,
  getUserPreferences,
  updateUserPreferences,
} from "./database/games.js";

// ─── LOANS, BOUNTIES, CHALLENGES, BOSS, PETS, TERRITORIES, HEISTS, AUCTIONS ───
export {
  createLoan,
  getActiveLoan,
  closeLoan,
  getOverdueLoans,
  createBounty,
  getActiveBounties,
  getBountyOnUser,
  claimBounty,
  getDailyChallenge,
  createDailyChallenge,
  completeDailyChallenge,
  createBossBattle,
  getActiveBoss,
  spawnBoss,
  damageBoss,
  getPet,
  getPetRaw,
  createPet,
  updatePet,
  feedPet,
  getTerritory,
  claimTerritory,
  getTerritories,
  collectTerritoryIncome,
  createHeist,
  getActiveHeist,
  joinHeist,
  resolveHeist,
  createAuction,
  getActiveAuctions,
  bidOnAuction,
  closeExpiredAuctions,
  createRoastBattle,
  getPendingRoast,
  updateRoastBattle,
  getPetBattleStats,
  recordPetBattle,
  trainPet,
} from "./database/activities.js";

// ─── CRAFTING / RECIPES (database/crafting.js) ────────────────────────────────
export {
  getDiscoveredRecipes,
  addDiscoveredRecipe,
} from "./database/crafting.js";

// ─── COOLDOWNS, ACTIVITY STREAKS, CAREER TIERS (database/cooldowns.js) ────────
export {
  getActivityStreak,
  incrementActivityStreak,
  getCareerTier,
  incrementCareerCount,
  checkCooldown,
  setCooldown,
  tryAcquireCooldown,
} from "./database/cooldowns.js";

// ─── GUILD SETTINGS, DIRECTIVES, FEATURE CONFIG (database/guildSettings.js) ───
export {
  getGuildSettings,
  setGuildSetting,
  getDirectives,
  addDirective,
  removeDirective,
  getFeatureConfig,
  setFeatureConfig,
} from "./database/guildSettings.js";
