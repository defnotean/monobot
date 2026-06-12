// ai/toolRegistry.js — Two-tier tool loading system
// Tier 1: Full schemas sent as API tools parameter (bounded most relevant)
// Tier 2: Compact grouped name catalog in system prompt (everything else)
// The AI can call ANY tool by name — the executor dispatches regardless of tier.

import { log } from "../utils/logger.js";

// ─── Tier-1 cap ─────────────────────────────────────────────────────────────
// Hard ceiling on full schemas sent per turn (the always-include core may
// exceed it — see the floor in selectByMessage — so core tools are never
// silently dropped). Override with TOOLS_TIER1_MAX: local 14B deployments
// want 16–20; hosted defaults to 32. Read once at module init.
const _tier1MaxEnv = parseInt(process.env.TOOLS_TIER1_MAX || "", 10);
export const MAX_TIER1_TOOLS =
  Number.isInteger(_tier1MaxEnv) && _tier1MaxEnv > 0 ? _tier1MaxEnv : 32;

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

/**
 * Channel key shape consumed by Eris two-tier selection.
 * Server turns are per-channel; DMs are per-user.
 * @param {any} message
 * @returns {string|null}
 */
export function channelKeyFor(message) {
  const userId = message?.author?.id || "unknown";
  if (!message) return null;
  if (!message.guild) return `dm:${userId}`;
  const channelId = message.channel?.id;
  return channelId ? `ch:${channelId}` : null;
}

function asPatternArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function normalizeKeywordSpec(keywordPattern) {
  if (!keywordPattern) return null;
  if (keywordPattern instanceof RegExp) {
    return { flat: [keywordPattern], strong: [], weak: [] };
  }
  return {
    flat: asPatternArray(keywordPattern.flat),
    strong: asPatternArray(keywordPattern.strong),
    weak: asPatternArray(keywordPattern.weak),
  };
}

function regexStats(pattern, text) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let hits = 0;
  let firstIndex = Infinity;
  let match;
  while ((match = re.exec(text)) !== null) {
    hits++;
    firstIndex = Math.min(firstIndex, match.index);
    if (match[0] === "") re.lastIndex++;
  }
  return { hits, firstIndex };
}

function keywordBandScore(patterns, text, base, positionWindow = 50) {
  let hits = 0;
  let firstIndex = Infinity;
  for (const pattern of patterns) {
    const stats = regexStats(pattern, text);
    hits += stats.hits;
    firstIndex = Math.min(firstIndex, stats.firstIndex);
  }
  if (hits === 0) return null;
  const positionBonus = Number.isFinite(firstIndex)
    ? Math.max(0, positionWindow - Math.min(firstIndex, positionWindow))
    : 0;
  return base + positionBonus + Math.min(hits, 20);
}

const GENERIC_NAME_TOKENS = new Set([
  "action", "start", "play", "game", "games", "bet", "spin", "roll",
  "guess", "attempt", "answer", "choice", "open", "all", "check", "list",
]);

class ToolRegistry {
  constructor() {
    this._tools = new Map();           // name -> full tool definition
    this._categories = new Map();      // category -> { names: string[], keywords: RegExp }
    this._toolCategories = new Map();  // name -> category
    this._alwaysInclude = new Set();   // tool names always in Tier 1
    this._recentUsage = new Map();     // channelKey -> [toolName, toolName, ...]
    this._maxRecent = 10;
  }

  // ─── Registration ───

  registerTools(tools, category, keywordPattern) {
    if (!this._categories.has(category)) {
      this._categories.set(category, { names: [], keywords: normalizeKeywordSpec(keywordPattern) });
    }
    const cat = this._categories.get(category);
    for (const tool of tools) {
      this._tools.set(tool.name, tool);
      if (!this._toolCategories.has(tool.name) || category !== "always_include") {
        this._toolCategories.set(tool.name, category);
      }
      if (!cat.names.includes(tool.name)) cat.names.push(tool.name);
    }
  }

  registerAlwaysInclude(names) {
    for (const n of names) this._alwaysInclude.add(n);
  }

  // ─── Selection ───

  /**
   * @param {string} text
   * @param {{ isOwner?: boolean, isTwin?: boolean, channelKey?: string|null,
   *           demotedCores?: Set<string>|string[],
   *           everyoneTools?: Array<{ name: string }>,
   *           ownerTools?: Array<{ name: string }> }} [opts]
   */
  selectByMessage(text, { isOwner = false, isTwin = false, channelKey = null, demotedCores = [], everyoneTools = [], ownerTools = [] } = {}) {
    const lower = (text || "").toLowerCase();
    const demotedCoreSet = demotedCores instanceof Set ? demotedCores : new Set(demotedCores || []);

    // Twin sister: minimal fun-only tools
    if (isTwin) {
      const FUN_NAMES = ["send_gif", "create_meme", "search_meme_templates", "get_mood", "get_relationship", "remember_fact", "web_search"];
      const tier1 = everyoneTools.filter(t => FUN_NAMES.includes(t.name));
      return { tier1, tier2Catalog: "", tier2Names: [] };
    }

    const scores = new Map();
    const bumpScore = (name, score) => {
      scores.set(name, Math.max(scores.get(name) || 0, score));
    };

    // Always-include core ranks above keyword matches unless toolProfiles has
    // marked a core irrelevant for this turn. Demoted cores stay reachable, but
    // score below strong intent so a small TOOLS_TIER1_MAX can actually bite.
    for (const name of this._alwaysInclude) bumpScore(name, demotedCoreSet.has(name) ? 600 : 1000);

    // Add tools from categories whose keywords match, scored by match
    // strength: more keyword hits rank a category's tools higher, and a tool
    // whose own name tokens appear in the message outranks its category
    // siblings (so "blackjack" keeps blackjack_start under the cap even when
    // the games category alone overflows it).
    //
    // Three bands, deliberately ordered around demoted cores (600),
    // recent-usage (891–900), and the non-demoted always-include core (1000):
    //   * Weak category match → 500s. Generic verbs like "play" and "start"
    //     should not drag game schemas into ordinary chat.
    //   * Flat/legacy category match → 700s.
    //   * Strong category or name-token match → 850+/910+. Explicit intent must
    //     survive the Tier-1 cap even in a channel full of stale recent usage.
    for (const [, cat] of this._categories) {
      if (!cat.keywords) continue;
      const weakScore = keywordBandScore(cat.keywords.weak, lower, 500);
      const flatScore = keywordBandScore(cat.keywords.flat, lower, 700);
      const strongScore = keywordBandScore(cat.keywords.strong, lower, 850);
      const base = Math.max(weakScore ?? 0, flatScore ?? 0, strongScore ?? 0);
      if (!base) continue;
      for (const name of cat.names) {
        let nameTokenHits = 0;
        for (const token of name.split("_")) {
          if (GENERIC_NAME_TOKENS.has(token)) continue;
          if (token.length >= 3 && lower.includes(token)) nameTokenHits++;
        }
        const score = nameTokenHits > 0
          ? Math.min(910 + (nameTokenHits - 1) * 25, 990)
          : base;
        bumpScore(name, score);
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
        for (let i = 0; i < recent.length; i++) {
          const name = recent[i];
          if (this._tools.has(name) && !GAME_TOOL_NAMES.has(name)) bumpScore(name, 900 - i);
        }
      }
    }

    // Determine accessible tools
    const accessibleNames = new Set();
    for (const t of everyoneTools) accessibleNames.add(t.name);
    if (isOwner) {
      for (const t of ownerTools) accessibleNames.add(t.name);
    }

    const accessible = [...accessibleNames]
      .map((name, index) => ({ name, index, tool: this._tools.get(name) }))
      .filter((entry) => entry.tool);
    const alwaysAccessible = accessible.filter((entry) => this._alwaysInclude.has(entry.name));
    // Floor only at the non-demoted core count. Demoted cores can fall through
    // to Tier 2, which lets local deployments use sub-core caps like 16.
    const nonDemotedAlwaysCount = alwaysAccessible.filter((entry) => !demotedCoreSet.has(entry.name)).length;
    const tier1Limit = Math.max(MAX_TIER1_TOOLS, nonDemotedAlwaysCount);
    const ranked = accessible
      .filter((entry) => scores.has(entry.name))
      .sort((a, b) => {
        const scoreDelta = (scores.get(b.name) || 0) - (scores.get(a.name) || 0);
        return scoreDelta || a.index - b.index;
      });
    const tier1NameSet = new Set(ranked.slice(0, tier1Limit).map((entry) => entry.name));

    this._shadowLogCaps(ranked, nonDemotedAlwaysCount, tier1NameSet);

    // Split into tiers. Tier 1 is bounded to keep per-turn schema volume
    // predictable; any relevant tools beyond the cap remain reachable by exact
    // name through Tier 2.
    const tier1 = [];
    const tier2ByCategory = new Map();
    const tier2Names = [];

    for (const { name, tool } of accessible) {
      if (tier1NameSet.has(name)) {
        tier1.push(tool);
      } else {
        const category = this._toolCategories.get(name) || "other";
        if (!tier2ByCategory.has(category)) tier2ByCategory.set(category, []);
        tier2ByCategory.get(category).push(name);
        tier2Names.push(name);
      }
    }

    const tier2Lines = [...tier2ByCategory]
      .map(([category, names]) => `- ${category}: ${names.join(", ")}`);
    const tier2Catalog = tier2Lines.length > 0
      ? `\n\nOTHER AVAILABLE TOOLS (call these through use_tool with {tool_name, arguments}; schemas are omitted here to save tokens):\n${tier2Lines.join("\n")}`
      : "";

    return { tier1, tier2Catalog, tier2Names };
  }

  // ─── Shadow cap telemetry ───

  /**
   * When TOOLS_SHADOW_LOG is truthy, log what Tier-1 caps of 16 and 20 WOULD
   * have dropped from this selection (tool names) — rollout telemetry for
   * tuning TOOLS_TIER1_MAX. Zero behavior change: the selection itself is
   * untouched and nothing is logged when the env is unset. The always-include
   * floor applies to the hypothetical caps too, mirroring the real cap.
   * @param {Array<{ name: string }>} ranked
   * @param {number} alwaysCount
   * @param {Set<string>} tier1NameSet
   */
  _shadowLogCaps(ranked, alwaysCount, tier1NameSet) {
    if (!process.env.TOOLS_SHADOW_LOG) return;
    const droppedAt = (cap) => {
      const kept = new Set(
        ranked.slice(0, Math.max(cap, alwaysCount)).map((entry) => entry.name)
      );
      return ranked
        .filter((entry) => tier1NameSet.has(entry.name) && !kept.has(entry.name))
        .map((entry) => entry.name);
    };
    const drop16 = droppedAt(16);
    const drop20 = droppedAt(20);
    log(
      `[REGISTRY] shadow-cap tier1=${tier1NameSet.size} ` +
      `cap16-drops(${drop16.length})=[${drop16.join(", ")}] ` +
      `cap20-drops(${drop20.length})=[${drop20.join(", ")}]`
    );
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

  getDeclaration(name) {
    return this.getToolByName(name);
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
    "send_gif", "analyze_image", "search_images", "show_image", "send_file", "generate_image", "edit_image", "search_meme_templates", "create_meme",
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
    {
      strong: /\b(balance|coins?|daily reward|weekly reward|monthly reward|shop|inventory|loan|borrow|bounty|daily challenge|achievements?|badges?|leaderboard|wallet|bank|deposit|withdraw|prestige|multiplier)\b/i,
      weak: /\b(buy|store|rich|broke|money|give|pay|transfer|how much|daily|weekly|monthly|challenge)\b/i,
    }
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
    {
      strong: /\b(blackjack|slots?|slot machine|coin\s*flip|dice|roulette|rps|rock paper scissors|trivia|quiz|word scramble|number guess|duel|roast battle|hot take|russian roulette|scratch card|lootbox|all in|wager|bet\s+\d+|\d+\s*coins?)\b/i,
      weak: /\b(play|start|game|deal|cards?|hit|stand|double|roll|guess|fight|challenge|accept|word|number|spin|flip|bet|gamble|rob|steal|scratch|lootbox|roast)\b/i,
    }
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
