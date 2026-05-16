// ai/toolRegistry.js — Two-tier tool loading system
// Tier 1: Full schemas sent as API tools parameter (15-25 most relevant)
// Tier 2: Name+description catalog in system prompt (everything else)
// The AI can call ANY tool by name — the executor dispatches regardless of tier.

import { log } from "../utils/logger.js";

// ─── Canonical economy-mutating tool list ──────────────────────────────────
// Single source of truth for "tools that consume/produce coins, items, or
// other shared economy state per call". Three cross-cutting features need
// the same set with slightly different framing:
//
//   1. dual.js → parallel-call dedup: only execute the first game/economy
//      tool per turn so "eris slots" doesn't also fire blackjack.
//   2. toolRegistry.js (this file) → recent-usage suppression: don't auto-
//      boost a game tool back into Tier 1 just because it was used recently
//      in this channel — let keyword routing decide each turn.
//   3. executor.js → cache invalidation: after one of these runs, drop the
//      user's cached read-tool results so their next "check balance" is fresh.
//
// Historically these were three hand-maintained `new Set([...])` literals
// in three files. They drifted (dual.js had `shop_browse`, registry didn't,
// executor had bank/memory writes the others didn't). Drift produces
// inconsistent dedup vs cache-invalidation behavior across iterations.
//
// Each consumer now imports `getEconomyMutatingTools()` and may extend it
// with feature-specific extras (executor.js adds memory writes + bank +
// marriage + crafting that aren't "games" but still mutate user state).
export const ECONOMY_MUTATING_TOOLS = Object.freeze([
  // ── gambling games ─────────────────────────────────────────────────────
  "coinflip_bet", "dice_roll_bet", "slots_spin",
  "blackjack_start", "blackjack_action",
  "russian_roulette", "rps_play",
  // ── trivia / mini-games ─────────────────────────────────────────────────
  "trivia_start", "trivia_answer",
  "word_scramble_start", "word_scramble_guess",
  "number_guess_start", "number_guess_attempt",
  // ── grinding activities ─────────────────────────────────────────────────
  "fish", "hunt", "dig", "work", "beg", "search_location",
  // ── PvP / pets ─────────────────────────────────────────────────────────
  "rob_user", "start_duel", "accept_duel",
  "pet_battle", "pet_train",
  // ── loot / lottery ─────────────────────────────────────────────────────
  "scratch_card", "open_lootbox", "open_all_lootboxes",
  // ── multi-step / event tools ───────────────────────────────────────────
  "adventure_start", "adventure_choice",
  "heist_start", "heist_join", "heist_execute",
  "boss_spawn", "boss_attack",
  // ── timed rewards ───────────────────────────────────────────────────────
  "daily_reward", "weekly_reward", "monthly_reward",
  // ── shop ───────────────────────────────────────────────────────────────
  "shop_browse", "shop_buy",
]);

/**
 * Returns the canonical list of economy-mutating tool names as a fresh
 * Array. Callers typically wrap it in a `new Set(...)` for O(1) `.has()`.
 * @returns {string[]}
 */
export function getEconomyMutatingTools() {
  return [...ECONOMY_MUTATING_TOOLS];
}

class ToolRegistry {
  constructor() {
    this._tools = new Map();           // name -> full tool definition
    this._categories = new Map();      // category -> { names: string[], keywords: RegExp }
    this._alwaysInclude = new Set();   // tool names always in Tier 1
    this._recentUsage = new Map();     // channelKey -> [toolName, toolName, ...]
    this._maxRecent = 10;
  }

  // ─── Registration ───

  registerTools(tools, category, keywordPattern) {
    if (!this._categories.has(category)) {
      this._categories.set(category, { names: [], keywords: keywordPattern || null });
    }
    const cat = this._categories.get(category);
    for (const tool of tools) {
      this._tools.set(tool.name, tool);
      if (!cat.names.includes(tool.name)) cat.names.push(tool.name);
    }
  }

  registerAlwaysInclude(names) {
    for (const n of names) this._alwaysInclude.add(n);
  }

  // ─── Selection ───

  selectByMessage(text, { isOwner = false, isTwin = false, channelKey = null, everyoneTools = [], ownerTools = [] } = {}) {
    const lower = (text || "").toLowerCase();

    // Twin sister: minimal fun-only tools
    if (isTwin) {
      const FUN_NAMES = ["send_gif", "create_meme", "search_meme_templates", "get_mood", "get_relationship", "remember_fact", "web_search"];
      const tier1 = everyoneTools.filter(t => FUN_NAMES.includes(t.name));
      return { tier1, tier2Catalog: "" };
    }

    const tier1Names = new Set([...this._alwaysInclude]);

    // Add tools from categories whose keywords match
    for (const [, cat] of this._categories) {
      if (cat.keywords && cat.keywords.test(lower)) {
        for (const name of cat.names) tier1Names.add(name);
      }
    }

    // Boost recently used tools in this channel — but skip economy-mutating
    // tools so the AI doesn't auto-fire them every time the channel mentions
    // games. Canonical list lives at the top of this file; see the comment
    // there for why dual.js and executor.js share the same source.
    const GAME_TOOL_NAMES = new Set(ECONOMY_MUTATING_TOOLS);
    if (channelKey) {
      const recent = this._recentUsage.get(channelKey);
      if (recent) {
        for (const name of recent) {
          if (this._tools.has(name) && !GAME_TOOL_NAMES.has(name)) tier1Names.add(name);
        }
      }
    }

    // Determine accessible tools
    const accessibleNames = new Set();
    for (const t of everyoneTools) accessibleNames.add(t.name);
    if (isOwner) {
      for (const t of ownerTools) accessibleNames.add(t.name);
    }

    // Split into tiers
    const tier1 = [];
    const tier2Lines = [];

    for (const name of accessibleNames) {
      const tool = this._tools.get(name);
      if (!tool) continue;

      if (tier1Names.has(name)) {
        tier1.push(tool);
      } else {
        const desc = (tool.description || "").split(/\.\s/)[0];
        tier2Lines.push(`- ${name}: ${desc}`);
      }
    }

    const tier2Catalog = tier2Lines.length > 0
      ? `\n\nOTHER AVAILABLE TOOLS (you can call these by name — just use the tool name and provide the required arguments):\n${tier2Lines.join("\n")}`
      : "";

    return { tier1, tier2Catalog };
  }

  // ─── Usage tracking ───

  trackUsage(channelKey, toolName) {
    if (!channelKey) return;
    let recent = this._recentUsage.get(channelKey);
    if (!recent) {
      recent = [];
      this._recentUsage.set(channelKey, recent);
    }
    const idx = recent.indexOf(toolName);
    if (idx !== -1) recent.splice(idx, 1);
    recent.unshift(toolName);
    if (recent.length > this._maxRecent) recent.pop();

    if (this._recentUsage.size > 1000) {
      const keys = [...this._recentUsage.keys()];
      for (let i = 0; i < 200; i++) this._recentUsage.delete(keys[i]);
    }
  }

  // ─── Lookup ───

  getToolByName(name) {
    return this._tools.get(name) || null;
  }

  getAllToolNames() {
    return [...this._tools.keys()];
  }

  getStats() {
    return {
      totalTools: this._tools.size,
      categories: this._categories.size,
      alwaysInclude: this._alwaysInclude.size,
    };
  }
}

// ─── Singleton ───
export const registry = new ToolRegistry();

// ─── Category Registration ───

export function registerOpenClawTools(EVERYONE_TOOLS, OWNER_TOOLS) {
  // ── Always-include (core tools for every conversation) ──
  const alwaysInclude = [
    "remember_fact", "forget_fact", "forget_all", "recall_memories",
    "send_gif", "analyze_image", "search_images", "search_meme_templates", "create_meme",
    "web_search", "scrape_url", "check_presence",
    "save_note", "list_notes", "delete_note", "search_notes",
    "set_reminder", "list_reminders", "cancel_reminder",
    "get_mood", "get_relationship",
    "configure_feature", "list_features", "toggle_twin_chat",
    "ask_irene",
  ];
  registry.registerAlwaysInclude(alwaysInclude);
  registry.registerTools(
    [...EVERYONE_TOOLS, ...OWNER_TOOLS].filter(t => alwaysInclude.includes(t.name)),
    "always_include",
    null
  );

  // ── Economy ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "check_balance", "daily_reward", "coin_leaderboard",
      "shop_browse", "shop_buy", "inventory_check",
      "loan_request", "loan_status", "loan_repay",
      "place_bounty", "bounty_board",
      "daily_challenge_check", "daily_challenge_complete", "achievements_list",
      "weekly_reward", "monthly_reward",
      "bank_deposit", "bank_withdraw", "bank_info",
      "give_coins", "prestige", "multiplier_check",
    ].includes(t.name)),
    "economy",
    /\b(balance|coins?|daily|shop|buy|store|inventory|loan|borrow|bounty|challenge|achievements?|badges?|leaderboard|rich|broke|money|give|pay|transfer|how much|wallet|weekly|monthly|bank|deposit|withdraw|prestige|multiplier)\b/i
  );

  // ── Gambling/Games ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "coinflip_bet", "dice_roll_bet", "slots_spin",
      "blackjack_start", "blackjack_action",
      "rob_user", "russian_roulette", "rps_play",
      "trivia_start", "trivia_answer",
      "word_scramble_start", "word_scramble_guess",
      "number_guess_start", "number_guess_attempt",
      "start_duel", "accept_duel",
      "roast_challenge", "hot_take",
      "scratch_card", "open_lootbox",
    ].includes(t.name)),
    "games",
    /\b(bet|gamble|flip|slots?|spin|blackjack|hit|stand|double|roll|dice|rob|steal|roulette|rps|rock|paper|scissors|trivia|quiz|scramble|guess|duel|fight|challenge|roast|hot take|accept|word|number|russian|play|start|game|deal|cards?|wager|all in|scratch|lootbox)\b/i
  );

  // ── Advanced Economy ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "stock_market", "stock_buy", "stock_sell",
      "heist_start", "heist_join", "heist_execute",
      "boss_spawn", "boss_attack", "boss_status",
      "territory_claim", "territory_map", "territory_collect",
      "pet_adopt", "pet_feed", "pet_status", "pet_rename", "pet_battle", "pet_train",
      "adventure_start", "adventure_choice",
      "marry", "divorce", "partner_status",
      "craft_item", "craft_recipes", "trade_offer", "use_item",
    ].includes(t.name)),
    "advanced",
    /\b(stock|invest|portfolio|shares?|market|heist|boss|attack|spawn|territory|claim|collect|pet|adopt|feed|auction|bid|adventure|marry|divorce|partner|craft|recipe|trade|use item)\b/i
  );

  // ── Grinding Activities ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "fish", "hunt", "dig", "work", "beg", "search_location",
    ].includes(t.name)),
    "grinding",
    /\b(fish|hunt|dig|work|beg|search|grind|farm)\b/i
  );

  // ── Code/Dev Tools ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "review_code", "save_snippet", "get_snippet", "list_snippets",
    ].includes(t.name)),
    "code",
    /\b(code|snippet|review|debug|programming|function|class|import)\b/i
  );

  // ── News/Prices ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "watch_price", "check_prices", "unwatch_price",
    ].includes(t.name)),
    "news",
    /\b(news|price|track|watch|crypto|bitcoin|stock price)\b/i
  );

  // ── Fun/Social ──
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "fortune_tell", "submit_confession", "apply_curse",
    ].includes(t.name)),
    "fun",
    /\b(fortune|confess|curse|hex|predict)\b/i
  );

  // ── Event / chat channel config ──
  // Catches natural-language asks about where events fire and where Eris talks,
  // so the tool lands in Tier 1 when users say "only fire events in X",
  // "don't fire events in #general", "dont chat here", etc.
  registry.registerTools(
    EVERYONE_TOOLS.filter(t => [
      "set_event_channels", "set_chat_channels",
    ].includes(t.name)),
    "channel_restrictions",
    /\b(events?|coin rain|chaos storm|lucky hour|pirate raid|random event|spawn|fire|trigger|dont (send|fire|spawn|do|chat|talk)|stop (sending|firing|spawning|chatting|talking)|only (send|fire|spawn|chat|talk|respond).*(in|to)|restrict.*(to|in)|whitelist|denylist|blacklist|allowlist|block|mute (this|here|channel|#)|unmute|stay (out|quiet)|shut up in|dont reply in|no events in|never.*events|only.*events|where (do|does|can|should).*you|where.*respond|where.*talk|where.*reply|turn off|turn on|disable|enable|deny|undeny|allow|disallow)\b/i
  );

  // ── Owner tools (always Tier 1 when owner is talking) ──
  registry.registerTools(OWNER_TOOLS, "owner", null);

  // Register any remaining uncategorized everyone tools
  const registered = new Set();
  for (const [, cat] of registry._categories) {
    for (const n of cat.names) registered.add(n);
  }
  for (const n of registry._alwaysInclude) registered.add(n);

  const uncategorized = EVERYONE_TOOLS.filter(t => !registered.has(t.name));
  if (uncategorized.length > 0) {
    registry.registerTools(uncategorized, "other", null);
  }

  const stats = registry.getStats();
  log(`[REGISTRY] ${stats.totalTools} tools registered across ${stats.categories} categories (${stats.alwaysInclude} always-included)`);
}
