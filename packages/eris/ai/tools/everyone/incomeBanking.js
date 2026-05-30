// @ts-check
// ─── packages/eris/ai/tools/everyone/incomeBanking.js ────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — INCOME, BANKING, REWARDS, GAMES, PROGRESSION, MARRIAGE
// The grind half: fish/hunt/dig/work/beg/search income tools, weekly/monthly
// rewards, bank deposit/withdraw/info, give_coins transfer (taxed), scratch
// cards / lootboxes / adventures, prestige & multipliers, marriage flow,
// crafting/trading, pet battles & training, and consumable item activation.
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const INCOME_BANKING_TOOLS = [
  // ─── Income & Activity Tools ───────────────────────────────────────────────
  {
    name: "fish",
    description: "Go fishing! Catch fish from common to mythic rarity for coins. 30s cooldown. Fishing Rod from shop boosts rare catches. Use when someone says 'fish', 'go fishing', 'cast a line'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hunt",
    description: "Go hunting! Encounter animals from squirrels to phoenixes for coins. 45s cooldown. Hunting Rifle from shop boosts rare finds. Use when someone says 'hunt', 'go hunting'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "dig",
    description: "Dig for treasure! Find items from rusty nails to ancient artifacts. 30s cooldown. Metal Detector from shop boosts rare finds. Use when someone says 'dig', 'treasure hunt', 'excavate'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "work",
    description: "Work a random job for coins (50-200). 30min cooldown. Use when someone says 'work', 'get a job', 'earn money'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "beg",
    description: "Beg for coins. Small random amount, sometimes negative. 30s cooldown. Use when someone says 'beg', 'spare some change', 'panhandle'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_location",
    description: "Search a random location for coins and items. 20s cooldown. Use when someone says 'search', 'scavenge', 'look around', 'explore'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Reward Tools ──────────────────────────────────────────────────────────
  {
    name: "weekly_reward",
    description: "Claim weekly reward (500+ coins, streak bonus). 7-day cooldown. Use when someone says 'weekly', 'claim weekly'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "monthly_reward",
    description: "Claim monthly reward (5000+ coins, streak bonus). 30-day cooldown. Use when someone says 'monthly', 'claim monthly'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Banking Tools ─────────────────────────────────────────────────────────
  {
    name: "bank_deposit",
    description: "Deposit coins into bank (protected from robbery). Capacity increases with prestige. Use when someone says 'deposit', 'bank deposit', 'save coins'.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Amount to deposit" } }, required: ["amount"] },
  },
  {
    name: "bank_withdraw",
    description: "Withdraw coins from bank to wallet. Use when someone says 'withdraw', 'bank withdraw', 'take out coins'.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Amount to withdraw" } }, required: ["amount"] },
  },
  {
    name: "bank_info",
    description: "View bank balance, capacity, interest earned. 1% daily interest on bank deposits. Use when someone says 'bank', 'bank info', 'bank balance'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Transfer Tool ─────────────────────────────────────────────────────────
  {
    name: "give_coins",
    description: "Send coins to another user (5% tax, minimum 10). Use when someone says 'give coins', 'send money', 'pay someone', 'transfer coins'. Pass either user_id (Discord snowflake) OR username (display name / mention) — both are accepted.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID of recipient" }, username: { type: "string", description: "Username, display name, or @mention of recipient (used if user_id missing)" }, amount: { type: "number", description: "Amount to send" } }, required: ["amount"] },
  },
  // ─── New Games ─────────────────────────────────────────────────────────────
  {
    name: "scratch_card",
    description: "Buy a scratch card. 3x3 grid, match 3 symbols in a line to win 2x-50x payout. Use when someone says 'scratch card', 'scratch', 'scratch off'. Tier is OPTIONAL — if the user didn't specify 50/100/250, just call this tool with no tier (it defaults to 50, the cheapest). Don't ask the user for a tier, don't fall back to check_balance — just play.",
    input_schema: { type: "object", properties: { tier: { type: "number", description: "Card cost: 50, 100, or 250. Omit to default to 50." } } },
  },
  {
    name: "open_lootbox",
    description: "Open a loot box from your inventory. Contains random coins or items. Buy loot boxes from the shop. Use when someone says 'open lootbox', 'open loot box', 'lootbox'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "adventure_start",
    description: "Start a multi-choice text adventure with branching paths and rewards. NO ARGUMENTS REQUIRED — just call this tool whenever the user says any of: 'adventure', 'quest', 'start adventure', 'go on an adventure', 'can i go on an adventure'. Do NOT fall back to check_balance for adventure requests — adventure has its own internal balance handling. Always call this tool for the message author (the person whose message you're replying to right now), regardless of who else was active in the recent chat.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "adventure_choice",
    description: "Make a choice in your current adventure. Use when someone responds to an adventure prompt with their choice.",
    input_schema: { type: "object", properties: { choice: { type: "string", description: "The choice to make" } }, required: ["choice"] },
  },
  // ─── Progression Tools ─────────────────────────────────────────────────────
  {
    name: "prestige",
    description: "Reset your balance for a permanent +10% earnings multiplier. Cost: 5000 × (current_level + 1). Use when someone says 'prestige', 'reset for prestige'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "multiplier_check",
    description: "View all active earnings multipliers (prestige, marriage, items, streaks). Use when someone says 'multiplier', 'my boosts', 'earnings bonus'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Marriage Tools ────────────────────────────────────────────────────────
  {
    name: "marry",
    description: "Propose to a user (costs 500 coins each, needs Wedding Ring). Married couples get +10% coin earnings. Use when someone says 'marry', 'propose', 'get married'. Pass either user_id or username.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID to marry" }, username: { type: "string", description: "Username/mention of who to marry (used if user_id missing)" } } },
  },
  {
    name: "divorce",
    description: "End your marriage (1000 coin alimony, partner gets 500). Use when someone says 'divorce', 'end marriage'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "partner_status",
    description: "Check your marriage status and how long you've been together. Use when someone says 'partner', 'marriage status', 'who am I married to'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Crafting Tools ────────────────────────────────────────────────────────
  {
    name: "craft_item",
    description: "Combine items from your inventory using recipes. Ingredients are NOT consumed on failure. Use when someone says 'craft', 'combine items', 'forge'.",
    input_schema: { type: "object", properties: { recipe: { type: "string", description: "Name of the item to craft" } }, required: ["recipe"] },
  },
  {
    name: "craft_recipes",
    description: "View discovered and undiscovered crafting recipes. Use when someone says 'recipes', 'crafting recipes', 'what can I craft'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "trade_offer",
    description: "Offer a trade to another user — items and/or coins. Use when someone says 'trade', 'swap items', 'offer trade'. Pass either user_id or username.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID to trade with" }, username: { type: "string", description: "Username/mention of trade partner (used if user_id missing)" }, offer_item: { type: "string", description: "Item to offer (optional)" }, want_item: { type: "string", description: "Item you want (optional)" }, offer_coins: { type: "number", description: "Coins to offer (optional)" }, want_coins: { type: "number", description: "Coins you want (optional)" } } },
  },
  // ─── Pet Battle Tools ──────────────────────────────────────────────────────
  {
    name: "pet_battle",
    description: "Battle your pet against another user's pet (3 rounds, speed determines turn order). Pets gain XP. Use when someone says 'pet battle', 'pet fight', 'challenge their pet'. Pass either user_id or username.",
    input_schema: { type: "object", properties: { user_id: { type: "string", description: "Discord user ID to battle" }, username: { type: "string", description: "Username/mention of opponent (used if user_id missing)" } } },
  },
  {
    name: "pet_train",
    description: "Train your pet's attack, defense, or speed (+1-3). Costs 100 coins, 1hr cooldown. Use when someone says 'train pet', 'pet train', 'level up pet'.",
    input_schema: { type: "object", properties: { stat: { type: "string", enum: ["attack", "defense", "speed"], description: "Stat to train (lowercase)" } }, required: ["stat"] },
  },
  // ─── Item Usage ────────────────────────────────────────────────────────────
  {
    name: "use_item",
    description: "Activate a consumable item from your inventory (Lucky Charm, Rob Shield, Life Saver, Double Daily, XP Boost, Mystery Box, etc). Use when someone says 'use item', 'activate', 'consume'.",
    input_schema: { type: "object", properties: { item: { type: "string", description: "Name of the item to use" } }, required: ["item"] },
  },
];
