// ─── packages/eris/ai/executor.js ───────────────────────────────────────
// Single dispatch entry point (executeTool). Applies TOOL_ALIASES, per-user
// rate limits, the read-only LRU cache, then walks SUB_EXECUTORS in order —
// first non-undefined wins. All ~170 tool implementations live downstream.
// See docs/ai-pipeline-eris.md §5 for the dispatch trace.
// ─── Tool Execution Engine ──────────────────────────────────────────────────
// Thin router that delegates to domain-specific sub-executors.
// Each sub-executor handles its own tool group and returns a string result
// or undefined if the tool isn't in its domain.

import * as db from "../database.js";
import config from "../config.js";
import { log } from "../utils/logger.js";
import { EVERYONE_TOOLS, OWNER_TOOLS } from "./tools.js";
import { LRUCache } from "@defnotean/shared/LRUCache";
import { checkToolRateLimit } from "../utils/toolRateLimit.js";
import { getEconomyMutatingTools } from "./toolRegistry.js";

// ─── Existing JS sub-executors ──────────────────────────────────────────────
import { executeEconomyTool } from "./economyExecutor.js";
import { executeActivityTool } from "./activityExecutor.js";
import { executeSocialTool } from "./socialExecutor.js";

// ─── New domain sub-executors ───────────────────────────────────────────────
import { execute as executeMemory } from "./executors/memoryExecutor.js";
import { execute as executeMedia } from "./executors/mediaExecutor.js";
import { execute as executeWeb } from "./executors/webExecutor.js";
import { execute as executeNotes } from "./executors/notesExecutor.js";
import { execute as executeSystem } from "./executors/systemExecutor.js";
import { execute as executeGithub } from "./executors/githubExecutor.js";
import { execute as executeAdmin } from "./executors/adminExecutor.js";
import { execute as executeTwin } from "./executors/twinExecutor.js";
import { execute as executeGambling } from "./executors/gamblingExecutor.js";
import { execute as executeGame } from "./executors/gameExecutor.js";
import { execute as executeCasino } from "./executors/casinoExecutor.js";
import { execute as executeMisc } from "./executors/miscExecutor.js";

// ─── Main executor ───────────────────────────────────────────────────────────

// Complete tool name alias map — all 110+ Evil tools.
// Exported so tests + the boot-time validator below can audit drift between
// alias targets and the canonical tool registry (tools.js).
export const TOOL_ALIASES = {
  remember: "remember_fact", save_fact: "remember_fact", memorize: "remember_fact",
  forget: "forget_fact", forget_everything: "forget_all", clear_memories: "forget_all",
  recall: "recall_memories", memories: "recall_memories", facts: "recall_memories",
  search: "web_search", google: "web_search", lookup: "web_search",
  scrape: "scrape_url", read_url: "scrape_url", read_page: "scrape_url",
  image_search: "search_images", find_image: "search_images",
  meme: "create_meme", make_meme: "create_meme",
  meme_template: "search_meme_templates", find_meme: "search_meme_templates",
  gif: "send_gif", reaction_gif: "send_gif",
  analyze: "analyze_image", analyse: "analyze_image", describe: "analyze_image", describe_image: "analyze_image",
  note: "save_note", notes: "list_notes", remove_note: "delete_note", find_note: "search_notes",
  remind: "set_reminder", reminder: "set_reminder", reminders: "list_reminders", cancel_remind: "cancel_reminder",
  code_review: "review_code", snippet: "save_snippet", snippets: "list_snippets",
  mood: "get_mood", feeling: "get_mood", relationship: "get_relationship", affinity: "get_relationship",
  price: "check_prices", prices: "check_prices",
  balance: "check_balance", coins: "check_balance", wallet: "check_balance", money: "check_balance",
  daily: "daily_reward", claim: "daily_reward",
  leaderboard: "coin_leaderboard", lb: "coin_leaderboard", top: "coin_leaderboard", richest: "coin_leaderboard",
  shop: "shop_browse", store: "shop_browse", buy: "shop_buy", purchase: "shop_buy",
  inventory: "inventory_check", inv: "inventory_check", items: "inventory_check",
  loan: "loan_request", borrow: "loan_request", debt: "loan_status", repay: "loan_repay",
  bounty: "place_bounty", bounties: "bounty_board",
  challenge: "daily_challenge_check", complete_challenge: "daily_challenge_complete",
  achievements: "achievements_list", badges: "achievements_list",
  coinflip: "coinflip_bet", flip: "coinflip_bet", coin_flip: "coinflip_bet", heads_or_tails: "coinflip_bet",
  dice: "dice_roll_bet", roll: "dice_roll_bet", dice_roll: "dice_roll_bet", roll_dice: "dice_roll_bet",
  slots: "slots_spin", slot: "slots_spin", spin: "slots_spin", slot_machine: "slots_spin",
  blackjack: "blackjack_start", bj: "blackjack_start", deal: "blackjack_start", cards: "blackjack_start",
  hit: "blackjack_action", stand: "blackjack_action", double_down: "blackjack_action",
  rob: "rob_user", steal: "rob_user", mug: "rob_user",
  roulette: "russian_roulette", russian: "russian_roulette",
  rps: "rps_play", rock_paper_scissors: "rps_play",
  trivia: "trivia_start", quiz: "trivia_start", answer: "trivia_answer",
  scramble: "word_scramble_start", word_game: "word_scramble_start", unscramble: "word_scramble_guess",
  number_guess: "number_guess_start", guess_number: "number_guess_start", guess: "number_guess_attempt",
  duel: "start_duel", fight: "start_duel", pvp: "start_duel", battle: "start_duel", accept: "accept_duel",
  fortune: "fortune_tell", predict: "fortune_tell",
  confess: "submit_confession", confession: "submit_confession",
  curse: "apply_curse", hex: "apply_curse", uncurse: "remove_curse", remove_hex: "remove_curse",
  roast: "roast_challenge", hottake: "hot_take",
  stocks: "stock_market", market: "stock_market", portfolio: "stock_market", my_stocks: "stock_market", chart: "stock_market",
  invest: "stock_buy", sell_stock: "stock_sell",
  heist: "heist_start", join_heist: "heist_join", execute_heist: "heist_execute",
  boss: "boss_spawn", raid: "boss_spawn", attack: "boss_attack", boss_hp: "boss_status",
  territory: "territory_map", map: "territory_map", claim_territory: "territory_claim",
  pet: "pet_status", my_pet: "pet_status", adopt: "pet_adopt", feed: "pet_feed", rename_pet: "pet_rename",
  features: "list_features", config: "configure_feature",
  twin: "toggle_twin_chat", irene: "ask_irene", sister: "ask_irene",
  bump_reminder: "configure_bump_reminder", bump_config: "configure_bump_reminder", setup_bump: "configure_bump_reminder",
  test_event: "test_fire_event", fire_event: "test_fire_event", trigger_event: "test_fire_event",
  event_channels: "set_event_channels", restrict_events: "set_event_channels", event_whitelist: "set_event_channels",
  track_game: "track_game", watch_game: "track_game", game_updates: "track_game", follow_game: "track_game",
  untrack_game: "untrack_game", unwatch_game: "untrack_game", stop_tracking: "untrack_game",
  game_watches: "list_game_watches", tracked_games: "list_game_watches",
  sing: "start_karaoke", karaoke: "start_karaoke", lyrics: "start_karaoke",
  stop_singing: "stop_karaoke", shut_up: "stop_karaoke", end_karaoke: "stop_karaoke",
  fishing: "fish", go_fish: "fish", cast: "fish",
  hunting: "hunt", go_hunt: "hunt",
  digging: "dig", excavate: "dig", treasure: "dig",
  job: "work", earn: "work",
  begging: "beg", spare_change: "beg", panhandle: "beg",
  scavenge: "search_location", explore: "search_location", look_around: "search_location",
  weekly: "weekly_reward", claim_weekly: "weekly_reward",
  monthly: "monthly_reward", claim_monthly: "monthly_reward",
  deposit: "bank_deposit", save_coins: "bank_deposit",
  withdraw: "bank_withdraw",
  bank: "bank_info", bank_balance: "bank_info",
  give: "give_coins", pay: "give_coins", transfer: "give_coins", send_coins: "give_coins",
  scratch: "scratch_card", scratchcard: "scratch_card", scratch_off: "scratch_card",
  lootbox: "open_lootbox", open_box: "open_lootbox", loot: "open_lootbox",
  adventure: "adventure_start", quest: "adventure_start", start_quest: "adventure_start",
  choose: "adventure_choice", pick: "adventure_choice",
  propose: "marry", get_married: "marry", marriage: "marry",
  end_marriage: "divorce",
  partner: "partner_status", spouse: "partner_status", married: "partner_status",
  combine: "craft_item", forge: "craft_item", make: "craft_item",
  recipes: "craft_recipes", recipe_list: "craft_recipes",
  trade: "trade_offer", swap: "trade_offer",
  pet_fight: "pet_battle", fight_pet: "pet_battle",
  train_pet: "pet_train", level_pet: "pet_train",
  use: "use_item", activate: "use_item", consume: "use_item",
  boost: "multiplier_check", multiplier: "multiplier_check", boosts: "multiplier_check",
  presence: "check_presence", online: "check_presence",
  terminal: "execute_terminal", shell: "execute_terminal", cmd: "execute_terminal",
  local: "execute_local", pc: "execute_local", files: "browse_files", ls: "browse_files",
  launch: "launch_app", processes: "list_processes", sysinfo: "system_info", specs: "system_info",
  deploy: "check_deploy", watch_deployment: "watch_deploy",
  emails: "read_emails", inbox: "read_emails", email: "draft_email", compose: "draft_email",
  repos: "github_repos", github: "github_repos", issues: "github_issues", prs: "github_prs",
  create_issue: "github_create_issue", repo_stats: "github_repo_stats",
  db: "query_database", sql: "query_database", database: "query_database", tables: "list_tables",
  whitelist: "whitelist_server", unwhitelist: "unwhitelist_server", whitelisted: "list_whitelist",
  trust: "trust_user", trusted: "list_trusted", untrust: "untrust_user",
  avatar: "change_avatar", pfp: "change_avatar", banner: "change_banner",
  nick: "change_nickname", personality: "update_personality", persona: "update_personality",
  forgive: "adjust_relationship", like_user: "adjust_relationship", hate_user: "adjust_relationship",
  set_mood: "adjust_mood", cheer_up: "adjust_mood", nap: "adjust_mood",
};

// ─── Alias resolution + registry validation ────────────────────────────────
// Two helpers that are exported for unit testing. Both treat the registry as
// the union of EVERYONE_TOOLS + OWNER_TOOLS in tools.js — that's the only
// surface the model ever sees, and the only set the dispatcher can serve.

/**
 * Resolve a (possibly aliased) tool name against the canonical registry.
 *
 * The returned shape lets the caller distinguish three outcomes:
 *   1. Direct hit:            { name, aliasUsed: false, known: true }
 *   2. Alias hit:             { name (canonical), aliasUsed: true, originalName, known: true }
 *   3. Still unknown after alias lookup: { name, originalName, known: false, error: { unknown, normalized } }
 *
 * Case 3 is the structured error the model can read back: it tells the model
 * both the literal string it emitted (`unknown`) and the post-alias name we
 * tried to dispatch on (`normalized`). The previous generic
 * "unknown tool: foo" string buried that signal inside the sub-executor
 * fallback path, so a Gemini-side typo on a real tool (e.g. `recall_facts`
 * → not aliased → fell through 12 sub-executors → generic error) gave the
 * model no usable hint on how to self-correct.
 *
 * @param {string} toolName            — the name the model emitted
 * @param {Set<string>} [registry]     — defaults to EVERYONE+OWNER tool names; override for tests
 */
export function resolveToolName(toolName, registry = _toolRegistryNames) {
  const original = toolName;
  const aliasTarget = Object.prototype.hasOwnProperty.call(TOOL_ALIASES, toolName)
    ? TOOL_ALIASES[toolName]
    : null;
  const normalized = aliasTarget || toolName;

  if (!registry.has(normalized)) {
    return {
      name: normalized,
      originalName: original,
      aliasUsed: aliasTarget !== null,
      known: false,
      error: { unknown: original, normalized },
    };
  }

  return {
    name: normalized,
    originalName: original,
    aliasUsed: aliasTarget !== null,
    known: true,
  };
}

/**
 * Boot-time audit: every TOOL_ALIASES *value* must point to a real registered
 * tool. If drift is found we throw a clear error listing the offenders, so a
 * stale alias is caught at startup instead of silently mapping a typo onto
 * another typo at request time.
 *
 * Accepts an optional `registry` (Set or array of names) to make the helper
 * testable in isolation — production calls pass the live tool list.
 *
 * @param {Set<string>|string[]} [registry]
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnDrift=true]  — set false for "soft" mode (log + return)
 * @returns {string[]} the list of alias targets that are NOT in the registry
 */
export function validateToolAliases(registry = _toolRegistryNames, opts = {}) {
  const { throwOnDrift = true } = opts;
  const registrySet = registry instanceof Set ? registry : new Set(registry || []);

  const offenders = [];
  for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
    if (!registrySet.has(target)) offenders.push({ alias, target });
  }

  if (offenders.length === 0) return [];

  const lines = offenders.map((o) => `  - ${o.alias} -> ${o.target}`).join("\n");
  const msg =
    `[EXECUTOR] TOOL_ALIASES drift detected: ${offenders.length} alias(es) ` +
    `point to tool names not in the registry. The model would silently ` +
    `auto-correct to a nonexistent tool. Fix tools.js or remove the alias.\n` +
    lines;

  if (throwOnDrift) {
    throw new Error(msg);
  }

  // Soft mode: visible warning, no crash. Used if a future build wants to ship
  // with known drift while a tool rename rolls out.
  log(msg);
  return offenders.map((o) => o.target);
}

// Canonical name set, computed once at module load. Used by resolveToolName
// (default arg) and the boot-time audit below.
const _toolRegistryNames = new Set(
  [...EVERYONE_TOOLS, ...OWNER_TOOLS].map((t) => t.name)
);

// Boot-time audit. Throws on drift unless ERIS_SKIP_ALIAS_VALIDATION=1 is set,
// which is the escape hatch for test runs that need to import the module
// without enforcing the full registry contract (e.g. when mocking).
if (process.env.ERIS_SKIP_ALIAS_VALIDATION !== "1") {
  validateToolAliases(_toolRegistryNames, { throwOnDrift: true });
}

// Counter for AI-hallucinated tools. Logged on first occurrence and every 10th
// thereafter so repeated hallucinations are visible without log spam. Declared
// up here so the executeTool top-of-function unknown-tool path can reference
// it (the inner sub-executor fallback below uses the same Map).
const _unknownToolCounts = new Map();

// ─── Tool Result Cache (LRU, 200 entries, 15s TTL) ────────────────────────
const _toolCache = new LRUCache(200, 15_000);
const CACHEABLE_TOOLS = new Set([
  "check_balance", "list_notes", "search_notes", "recall_memories",
  "list_snippets", "get_snippet", "get_mood", "get_relationship",
  "check_prices", "check_presence", "list_features",
  "coin_leaderboard", "achievements_list", "bounty_board",
  "stock_market",
  "inventory_check", "loan_status", "pet_status", "multiplier_check",
  "territory_map", "boss_status", "partner_status", "bank_info",
]);
// Write tools that should invalidate the cache. Built from the canonical
// ECONOMY_MUTATING_TOOLS list (toolRegistry.js) plus extras specific to
// cache invalidation: memory writes, bank/loan, marriage, crafting,
// prestige, curses, and other non-game state mutators. Keep the extras
// non-overlapping with the canonical list — toolRegistry.js owns games.
const CACHE_INVALIDATING_EXTRAS = [
  // memory + notes (read-cached, write-invalidate)
  "remember_fact", "forget_fact", "forget_all", "save_note", "delete_note",
  // banking + stocks + loans
  "bank_deposit", "bank_withdraw", "stock_buy", "stock_sell",
  "loan_request", "loan_repay",
  // transfers + relationship state
  "give_coins", "trade_offer", "marry", "divorce", "prestige",
  // pets that mutate inventory/state but aren't gambling/activity
  "pet_adopt", "pet_feed", "pet_rename",
  // crafting + items
  "craft_item", "use_item",
  // social mutators
  "submit_confession", "apply_curse", "remove_curse", "roast_challenge",
];
const CACHE_INVALIDATING_TOOLS = new Set([
  ...getEconomyMutatingTools(),
  ...CACHE_INVALIDATING_EXTRAS,
]);

function getCachedResult(toolName, args, userId) {
  if (!CACHEABLE_TOOLS.has(toolName)) return null;
  const key = `${userId || "?"}:${toolName}:${JSON.stringify(args || {})}`;
  return _toolCache.get(key) ?? null;
}

function setCachedResult(toolName, args, userId, result) {
  if (!CACHEABLE_TOOLS.has(toolName)) return;
  // Don't cache error strings — they'll mask real failures on retry
  if (typeof result === "string" && /^(Error:|Couldn't|Failed|Sorry,|You don't|Not enough)/i.test(result)) return;
  const key = `${userId || "?"}:${toolName}:${JSON.stringify(args || {})}`;
  // Use the user as the group key so invalidateUserCache can drop all of
  // this user's cached results in O(k) (where k = # keys for that user)
  // instead of scanning the whole LRU. Critical on economy-heavy servers
  // where we see 50–100 bets/second and every bet triggers invalidation.
  _toolCache.set(key, result, userId || "?");
}

/**
 * Drop every cached tool result for a given user. Used after the user
 * performs a write (gamble, buy, transfer) so their next read is fresh.
 * O(k) via the LRUCache group index instead of the previous O(n) full scan.
 */
function invalidateUserCache(userId) {
  if (!userId) return 0;
  return _toolCache.deleteGroup(userId);
}

// Tools that also mutate a second user's state (transfers, rob, trade, marry).
// For these we additionally invalidate the target user's cache if we can find
// their ID in the tool input.
const TWO_USER_TOOLS = new Set([
  "give_coins", "rob_user", "trade_offer", "marry", "divorce", "pet_battle",
]);

export async function executeTool(toolName, input, message) {
  // Resolve aliases AND verify the post-alias name exists in the registry.
  // If the model emits a name that doesn't exist (even after alias lookup),
  // we return a structured payload telling the model both what it wrote and
  // what we tried to dispatch — so a follow-up turn can self-correct instead
  // of getting a vague "unknown tool" string that obscures the fix.
  const resolution = resolveToolName(toolName);
  if (!resolution.known) {
    _unknownToolCounts.set(resolution.originalName, (_unknownToolCounts.get(resolution.originalName) || 0) + 1);
    const count = _unknownToolCounts.get(resolution.originalName);
    if (count === 1 || count % 10 === 0) {
      log(`[EXECUTOR] Unknown tool after alias: original=${resolution.originalName} normalized=${resolution.error.normalized} (hit #${count})`);
    }
    // String form keeps the existing wire shape (tools return strings) while
    // surfacing BOTH names so the model can self-correct. Downstream prompts
    // can grep for "unknown tool" and parse the JSON tail if they want a
    // structured handle.
    return `unknown tool: ${JSON.stringify(resolution.error)}`;
  }

  if (resolution.aliasUsed) {
    log(`[EXECUTOR] Auto-corrected tool: ${resolution.originalName} → ${resolution.name}`);
  }
  toolName = resolution.name;

  const userId = message?.author?.id;

  // Per-user rate limiting on expensive tools
  if (userId) {
    const rateCheck = checkToolRateLimit(userId, toolName);
    if (!rateCheck.allowed) {
      const secs = Math.ceil(rateCheck.retryAfterMs / 1000);
      return `chill — you're using ${toolName} too fast. try again in ${secs}s`;
    }
  }

  // Check cache for read-only tools
  const cached = getCachedResult(toolName, input, userId);
  if (cached !== null) {
    log(`[EXECUTOR] Cache hit: ${toolName}`);
    return cached;
  }

  const result = await _executeToolInner(toolName, input, message);

  // Invalidate cache AFTER successful tool execution to avoid losing cache on failure.
  // Per-user only — clearing the entire LRU on every write caused cache thrash
  // across all users whenever one user gambled.
  if (CACHE_INVALIDATING_TOOLS.has(toolName)) {
    invalidateUserCache(userId);
    if (TWO_USER_TOOLS.has(toolName)) {
      const targetId = input?.user_id || input?.target_id || input?.partner_id;
      if (targetId && /^\d{17,20}$/.test(String(targetId))) invalidateUserCache(String(targetId));
    }
  }

  setCachedResult(toolName, input, userId, result);
  return result;
}

// ─── Sub-executor registry (new TS modules) ─────────────────────────────────
// Tried in order; first non-undefined result wins.
const SUB_EXECUTORS = [
  executeMemory,
  executeMedia,
  executeWeb,
  executeNotes,
  executeSystem,
  executeGithub,
  executeAdmin,
  executeTwin,
  executeGambling,
  executeGame,
  executeCasino,
  executeMisc,
];

async function _executeToolInner(toolName, input, message) {
  // ── Delegate to existing JS sub-executors for modular feature groups ──
  const ECONOMY_TOOLS = ["shop_browse", "shop_buy", "inventory_check", "loan_request", "loan_status", "loan_repay", "place_bounty", "bounty_board", "daily_challenge_check", "daily_challenge_complete", "achievements_list"];
  if (ECONOMY_TOOLS.includes(toolName)) {
    return executeEconomyTool(toolName, input, message);
  }

  // Legacy stock tool names are redirected to `stock_market` (the new GBM-based
  // market in ai/stockMarket.js). `stock_buy` and `stock_sell` fall through to
  // miscExecutor which uses the hardened withUserLock path — do NOT dispatch
  // to the old stocksExecutor.js (which has race conditions against the
  // unlocked db.buyStock / db.sellStock pair).
  if (toolName === "stock_list" || toolName === "stock_portfolio" || toolName === "stock_history") {
    toolName = "stock_market";
  }

  const ACTIVITY_TOOLS = ["fish", "hunt", "dig", "work", "beg", "search_location", "weekly_reward", "monthly_reward"];
  if (ACTIVITY_TOOLS.includes(toolName)) {
    return executeActivityTool(toolName, input, message);
  }

  const SOCIAL_TOOLS = ["bank_deposit", "bank_withdraw", "bank_info", "give_coins", "scratch_card", "open_lootbox", "open_all_lootboxes", "adventure_start", "adventure_choice", "prestige", "multiplier_check", "marry", "divorce", "partner_status", "craft_item", "craft_recipes", "trade_offer", "pet_battle", "pet_train", "use_item"];
  if (SOCIAL_TOOLS.includes(toolName)) {
    return executeSocialTool(toolName, input, message);
  }

  // ── DISBOARD bump reminder config ─────────────────────────────────────
  if (toolName === "configure_bump_reminder") {
    const guildId = message.guild?.id;
    if (!guildId) return "this only works in servers";

    // Permission check — Manage Server or bot owner
    const isOwner = message.author.id === config.ownerId;
    const member = message.guild.members.cache.get(message.author.id)
      ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const hasPerms = member?.permissions?.has("ManageGuild") || isOwner;
    if (!hasPerms) {
      log(`[AUTH] ${message.author.id} denied configure_bump_reminder in ${guildId}`);
      return "you need Manage Server permission to configure the bump reminder";
    }

    const settings = db.getGuildSettings(guildId);
    let roles = Array.isArray(settings?.bump_ping_roles) ? [...settings.bump_ping_roles] : [];
    const action  = (input.action || "list").toLowerCase();
    const roleIds = Array.isArray(input.role_ids) ? input.role_ids.map(String) : [];

    if (action === "list") {
      if (!roles.length) return "no roles configured for bump reminders yet — use 'add' with some role IDs";
      return `bump reminder will ping: ${roles.map(id => `<@&${id}>`).join(", ")}`;
    }

    if (action === "add") {
      if (!roleIds.length) return "give me some role IDs to add";
      const added = roleIds.filter(id => !roles.includes(id));
      roles.push(...added);
      db.setGuildSetting(guildId, "bump_ping_roles", roles);
      return added.length
        ? `added ${added.map(id => `<@&${id}>`).join(", ")} to the bump reminder ping list`
        : "those roles were already on the list";
    }

    if (action === "remove") {
      if (!roleIds.length) return "give me some role IDs to remove";
      const before = roles.length;
      roles = roles.filter(id => !roleIds.includes(id));
      db.setGuildSetting(guildId, "bump_ping_roles", roles);
      return roles.length < before ? "removed those roles from bump reminders" : "those roles weren't on the list";
    }

    if (action === "clear") {
      db.setGuildSetting(guildId, "bump_ping_roles", []);
      return "cleared all bump reminder roles — i'll still post the reminder but won't ping anyone";
    }

    return `unknown action '${action}' — use add, remove, list, or clear`;
  }

  // ── Delegate to new TS sub-executors ──────────────────────────────────
  for (const subExecutor of SUB_EXECUTORS) {
    const result = await subExecutor(toolName, input, message, {});
    if (result !== undefined) return result;
  }

  // ── No sub-executor handled this tool ─────────────────────────────
  // Track unknown tools so we can spot AI hallucination patterns — if
  // Gemini/NVIDIA keeps inventing the same nonexistent tool, we want
  // to know so we can either add it or tighten the prompt.
  const userId = message?.author?.id || "unknown";
  _unknownToolCounts.set(toolName, (_unknownToolCounts.get(toolName) || 0) + 1);
  const count = _unknownToolCounts.get(toolName);
  const argPreview = JSON.stringify(input || {}).slice(0, 120);
  if (count === 1 || count % 10 === 0) {
    log(`[EXECUTOR] Unknown tool: ${toolName} (hit #${count}, user ${userId}, args: ${argPreview})`);
  }
  return `unknown tool: ${toolName}`;

}
