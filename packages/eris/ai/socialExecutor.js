// ─── Social Executor: Banking, Marriage, Crafting, Adventures, & More ───────
// bank_deposit, bank_withdraw, bank_info, give_coins, scratch_card, open_lootbox,
// adventure_start, adventure_choice, prestige, multiplier_check, marry, divorce,
// partner_status, craft_item, craft_recipes, trade_offer, pet_battle, pet_train, use_item

import { randomInt } from "crypto";
import * as db from "../database.js";
import { log } from "../utils/logger.js";
import { resolveMember } from "../utils/discord.js";
import { invalidateUserCache } from "./executor.js";

// Resolve a target user from any of (user_id, target_id, username) so the model
// can pass whichever is most natural for the request. user_id wins if present
// (it's an authoritative snowflake); username is only consulted in guild
// context where we can resolve via member index. Returns the resolved Discord
// snowflake or null if nothing resolvable was supplied.
async function resolveTargetUserId(input, message) {
  const direct = input?.user_id || input?.target_id;
  if (direct && /^\d{17,20}$/.test(String(direct))) return String(direct);
  const username = input?.username || input?.target_username || input?.target;
  if (username && message?.guild) {
    const member = await resolveMember(message.guild, String(username));
    if (member) return member.id;
  }
  // Last-resort: if direct is a non-snowflake string, try resolving it via guild.
  if (direct && message?.guild) {
    const member = await resolveMember(message.guild, String(direct));
    if (member) return member.id;
  }
  return null;
}

// Global marry/divorce lock — these are rare operations and the state is
// shared between two users, so serializing all of them is fine and keeps
// the correctness story simple. Prevents duplicate marriages, double
// dowry debits, and marry/divorce races.
let _marriagePipeline = Promise.resolve();
function _queueMarriageOp(fn) {
  const next = _marriagePipeline.catch(() => {}).then(fn);
  _marriagePipeline = next.catch(() => {}); // keep chain alive on errors
  return next;
}

// ─── Craft Recipes ─────────────────────────────────────────────────────────

const RECIPES = {
  "Lucky Fishing Rod": { ingredients: ["Fishing Rod", "Lucky Charm"], description: "2x rare fish chance" },
  "Power Drill": { ingredients: ["Metal Detector", "Lucky Charm"], description: "2x rare dig chance" },
  "Diamond Ring": { ingredients: ["Wedding Ring", "Lucky Charm"], description: "Flex item, +15% marriage bonus" },
  "Golden Trophy": { ingredients: ["Flex Badge", "Lucky Charm"], description: "Ultra-rare flex, shows on leaderboard" },
  "Chaos Orb": { ingredients: ["Mystery Box", "Mystery Box", "Mystery Box"], description: "Opens 5 mystery boxes at once" },
  "Pet Armor": { ingredients: ["Rob Shield", "Rob Shield"], description: "+5 pet defense permanently" },
  "Speed Boots": { ingredients: ["XP Boost", "XP Boost"], description: "+5 pet speed permanently" },
};

// ─── Scratch Card Symbols ──────────────────────────────────────────────────

const SCRATCH_SYMBOLS = {
  50: ["🍒", "🍋", "🍊", "🍇", "⭐"],
  100: ["🍒", "🍋", "🍊", "🍇", "⭐", "💎"],
  250: ["🍒", "🍋", "🍊", "🍇", "⭐", "💎", "👑"],
};

const SCRATCH_PAYOUTS = {
  "🍒": 2, "🍋": 3, "🍊": 4, "🍇": 5, "⭐": 10, "💎": 25, "👑": 50,
};

// ─── Loot Box Drops ────────────────────────────────────────────────────────

const LOOTBOX_DROPS = [
  { name: "coins", type: "coins", coins: [20, 50], weight: 30 },
  { name: "coins", type: "coins", coins: [50, 150], weight: 20 },
  { name: "coins", type: "coins", coins: [200, 500], weight: 8 },
  { name: "Lucky Charm", type: "item", weight: 10 },
  { name: "Rob Shield", type: "item", weight: 10 },
  { name: "XP Boost", type: "item", weight: 8 },
  { name: "Mystery Box", type: "item", weight: 6 },
  { name: "Life Saver", type: "item", weight: 5 },
  { name: "Fishing Rod", type: "item", weight: 2 },
  { name: "Hunting Rifle", type: "item", weight: 1 },
];

// ─── Adventure Scenarios ───────────────────────────────────────────────────

const ADVENTURES = [
  {
    title: "The Dark Cave",
    steps: [
      { text: "you enter a dark cave. you see two paths — left is dimly lit, right is pitch black", choices: ["left", "right"] },
      { text: { left: "the lit path leads to a small room with a chest. open it or leave?", right: "you stumble in the dark and find a glowing crystal. take it or leave it?" }, choices: ["take", "leave"] },
      { text: { take: "you grab the loot!", leave: "you play it safe" }, end: true, rewards: { take: [50, 200], leave: [10, 30] } },
    ],
  },
  {
    title: "The Sketchy Deal",
    steps: [
      { text: "a shady guy in an alley offers you a deal. 'i got something special.' hear him out or walk away?", choices: ["listen", "walk"] },
      { text: { listen: "he shows you a box. 'costs 50 coins. could be worth 500, could be worth nothing.' buy it?", walk: "you walk away. on the ground you spot a coin. pick it up?" }, choices: ["yes", "no"] },
      { text: { yes: "bold move!", no: "safe choice" }, end: true, rewards: { yes: [-50, 500], no: [5, 20] } },
    ],
  },
  {
    title: "Dragon's Lair",
    steps: [
      { text: "a dragon blocks your path! fight, sneak past, or try to befriend it?", choices: ["fight", "sneak", "befriend"] },
      { text: { fight: "the dragon breathes fire! dodge left or right?", sneak: "you're almost past when you step on a twig. freeze or run?", befriend: "the dragon seems interested. offer it food or a compliment?" }, choices: ["left", "right", "freeze", "run", "food", "compliment"] },
      { text: "the encounter resolves!", end: true, rewards: { left: [100, 300], right: [-50, 100], freeze: [50, 150], run: [0, 50], food: [150, 400], compliment: [80, 250] } },
    ],
  },
  {
    title: "Casino Heist",
    steps: [
      { text: "you're planning a casino heist. go through the front door or the ventilation?", choices: ["front", "vents"] },
      { text: { front: "security spots you! bribe them or make a run for it?", vents: "you're above the vault. drop down now or wait for the guard to leave?" }, choices: ["bribe", "run", "drop", "wait"] },
      { text: "the heist concludes!", end: true, rewards: { bribe: [-100, 400], run: [0, 100], drop: [200, 600], wait: [100, 300] } },
    ],
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function randInt(min, max) {
  return randomInt(min, max + 1);
}

function weightedRandom(table) {
  const totalWeight = table.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of table) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return table[table.length - 1];
}

// ─── Main Executor ─────────────────────────────────────────────────────────

export async function executeSocialTool(toolName, input, message) {
  const userId = message.author.id;

  switch (toolName) {

    // ─── Banking ───────────────────────────────────────────────────────

    case "bank_deposit": {
      const raw = Number(input.amount);
      if (!Number.isFinite(raw) || !Number.isInteger(raw)) return "amount must be a whole number";
      const amount = Math.min(Math.max(Math.floor(raw), 0), 1_000_000);
      if (amount <= 0) return "deposit amount must be positive";

      const result = await db.bankDeposit(userId, amount);
      if (!result.ok) {
        if (result.reason === "insufficient_wallet") return `you only have ${result.balance} coins in your wallet`;
        if (result.reason === "bank_full") return `bank full. capacity: ${result.capacity}, current: ${result.bank}. can deposit max ${result.maxDeposit}`;
        if (result.reason === "economy_unavailable") return "economy is offline rn, try again later";
        return `deposit failed: ${result.reason}`;
      }
      if (!await db.hasAchievement(userId, "first_deposit")) await db.unlockAchievement(userId, "first_deposit");
      if (result.newBankBalance >= result.capacity) {
        if (!await db.hasAchievement(userId, "full_bank")) await db.unlockAchievement(userId, "full_bank");
      }
      return `deposited ${amount} coins. bank: ${result.newBankBalance}/${result.capacity}`;
    }

    case "bank_withdraw": {
      const raw = Number(input.amount);
      if (!Number.isFinite(raw) || !Number.isInteger(raw)) return "amount must be a whole number";
      const amount = Math.min(Math.max(Math.floor(raw), 0), 1_000_000);
      if (amount <= 0) return "withdraw amount must be positive";

      const result = await db.bankWithdraw(userId, amount);
      if (!result.ok) {
        if (result.reason === "insufficient_bank") return `only ${result.balance} coins in bank`;
        if (result.reason === "economy_unavailable") return "economy is offline rn, try again later";
        return `withdraw failed: ${result.reason}`;
      }
      return `withdrew ${amount} coins. bank: ${result.newBankBalance}`;
    }

    case "bank_info": {
      const bank = await db.getBankBalance(userId);
      const cap = await db.getBankCapacity(userId);
      const interest = await db.applyBankInterest(userId);
      const bal = await db.getBalance(userId);
      let msg = `wallet: ${bal.balance} | bank: ${bank.balance}/${cap}`;
      if (interest > 0) msg += ` (earned ${interest} interest!)`;
      msg += ` | interest rate: 1%/day`;
      return msg;
    }

    // ─── Give Coins ────────────────────────────────────────────────────

    case "give_coins": {
      if (!message.guild) return "coin transfers only work in servers, not DMs";

      const targetId = await resolveTargetUserId(input, message);
      const rawAmount = Number(input.amount);
      if (!targetId) return "need a user to give coins to";
      if (!Number.isFinite(rawAmount) || !Number.isInteger(rawAmount)) return "amount must be a whole number";
      const amount = Math.min(Math.max(Math.floor(rawAmount), 0), 1_000_000);
      if (amount < 10) return "minimum transfer: 10 coins";
      if (targetId === userId) return "you can't give coins to yourself lol";

      // Verify recipient actually exists — otherwise coins would burn silently
      const targetUser = await message.client.users.fetch(targetId).catch(() => null);
      if (!targetUser) return `couldn't find user <@${targetId}> — did the AI make up that ID?`;
      if (targetUser.bot) return "you can't give coins to a bot lol";

      const tax = Math.ceil(amount * 0.05);
      const result = await db.transferBalance(userId, targetId, amount, tax, "give", `gave to ${targetId}`);

      if (!result.ok) {
        if (result.reason === "insufficient") {
          return `need ${result.required} coins (${amount} + ${tax} tax). you have ${result.balance}`;
        }
        if (result.reason === "economy_unavailable") return "economy is offline rn, try again later";
        return `transfer failed: ${result.reason}`;
      }

      if (!await db.hasAchievement(userId, "generous")) await db.unlockAchievement(userId, "generous");
      return `sent ${amount} coins to ${targetUser.username} (${tax} tax). your balance: ${result.newBalance}`;
    }

    // ─── Scratch Card ──────────────────────────────────────────────────

    case "scratch_card": {
      const tier = parseInt(input.tier || input.cost) || 50;
      if (![50, 100, 250].includes(tier)) return "scratch card tiers: 50, 100, 250 coins";
      return db.withUserLock(userId, async () => {
        const bal = await db.getBalance(userId);
        if (bal.balance < tier) return `need ${tier} coins. you have ${bal.balance}`;
        await db.updateBalanceUnsafe(userId, -tier, "scratch_buy", `tier ${tier}`);

        const symbols = SCRATCH_SYMBOLS[tier];
        const grid = Array.from({ length: 9 }, () => symbols[randInt(0, symbols.length - 1)]);

        // Check rows, columns, diagonals for 3 matches
        const lines = [
          [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
          [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
          [0, 4, 8], [2, 4, 6],             // diagonals
        ];

        let bestPayout = 0;
        let bestSymbol = null;
        for (const [a, b, c] of lines) {
          if (grid[a] === grid[b] && grid[b] === grid[c]) {
            const payout = tier * (SCRATCH_PAYOUTS[grid[a]] || 2);
            if (payout > bestPayout) { bestPayout = payout; bestSymbol = grid[a]; }
          }
        }

        const display = `${grid[0]}${grid[1]}${grid[2]}\n${grid[3]}${grid[4]}${grid[5]}\n${grid[6]}${grid[7]}${grid[8]}`;

        if (bestPayout > 0) {
          await db.updateBalanceUnsafe(userId, bestPayout, "scratch_win", `${bestSymbol} match`);
          return `scratch card (${tier} coins):\n${display}\n\n3x ${bestSymbol} match! won **${bestPayout}** coins!`;
        }
        return `scratch card (${tier} coins):\n${display}\n\nno matches. better luck next time`;
      });
    }

    // ─── Loot Box ──────────────────────────────────────────────────────

    case "open_lootbox": {
      // Serialize so two rapid clicks can't both pass the "has loot box"
      // check before either removal lands — old code let user open one box
      // twice and collect two rewards for one box consumed.
      return db.withUserLock(userId, async () => {
        const has = await db.hasItem(userId, "Loot Box");
        if (!has) return "you don't have a loot box. buy one from the shop (200 coins)";
        if (!await db.removeFromInventory(userId, "Loot Box")) return "you don't have a loot box. buy one from the shop (200 coins)";

        const drop = weightedRandom(LOOTBOX_DROPS);
        if (drop.type === "coins") {
          const coins = randInt(drop.coins[0], drop.coins[1]);
          // Unsafe variant — withUserLock is non-reentrant, so calling the
          // standard updateBalance (which re-acquires) would deadlock.
          await db.updateBalanceUnsafe(userId, coins, "lootbox", "opened loot box");
          return `opened a loot box — found **${coins} coins**!`;
        } else {
          await db.addToInventory(userId, drop.name, "item");
          return `opened a loot box — found a **${drop.name}**!`;
        }
      });
    }

    // ─── Batch: open multiple loot boxes at once ───────────────────────
    // Saves the user from spamming open_lootbox N times. Caps at 50 per call
    // to keep the embed summary readable and limit DB churn.
    case "open_all_lootboxes": {
      return db.withUserLock(userId, async () => {
        const inv = await db.getInventory(userId);
        const owned = inv.filter((i) => i.item_name === "Loot Box").length;
        if (owned === 0) return "you don't have any loot boxes";
        const rawCount = Number(input.count);
        const requested = Math.min(Math.max(Math.floor(Number.isFinite(rawCount) && rawCount > 0 ? rawCount : owned), 1), 50);
        const toOpen = Math.min(owned, requested);

        // Consume the boxes FIRST (loop) — if any single delete fails, bail
        // before crediting so we don't pay out for boxes still in inventory.
        let consumed = 0;
        try {
          for (let i = 0; i < toOpen; i++) {
            if (!await db.removeFromInventory(userId, "Loot Box")) throw new Error("loot box was already consumed");
            consumed++;
          }
        } catch (err) {
          // Best-effort refund for any partially-consumed boxes — add them back.
          for (let i = 0; i < consumed; i++) {
            try { await db.addToInventory(userId, "Loot Box", "item"); } catch {}
          }
          return `couldn't open loot boxes: ${err.message || err}`;
        }

        // Now compute rewards + credit all at once.
        let totalCoins = 0;
        const items = {};
        const itemFailures = {}; // name -> count of unwritten items (DB errors)
        for (let i = 0; i < consumed; i++) {
          const drop = weightedRandom(LOOTBOX_DROPS);
          if (drop.type === "coins") {
            const coins = randInt(drop.coins[0], drop.coins[1]);
            totalCoins += coins;
          } else {
            try {
              await db.addToInventory(userId, drop.name, "item");
              items[drop.name] = (items[drop.name] || 0) + 1;
            } catch (err) {
              // Don't count it as awarded if the write failed — keep the
              // tally honest. Track failures so we can surface them to the
              // user instead of silently eating their drop.
              itemFailures[drop.name] = (itemFailures[drop.name] || 0) + 1;
              log(`[Lootbox] addToInventory failed for ${userId} (${drop.name}): ${err?.message || err}`);
            }
          }
        }
        if (totalCoins > 0 && Number.isFinite(totalCoins)) {
          try {
            // Unsafe variant — withUserLock is non-reentrant.
            await db.updateBalanceUnsafe(userId, Math.floor(totalCoins), "lootbox", `opened ${consumed} loot boxes`);
          } catch (err) {
            // Coin credit failed — items were still awarded. Log so admins can reconcile.
            return `opened ${consumed} boxes but coin payout failed: ${err.message || err}`;
          }
        }

        const itemSummary = Object.entries(items)
          .map(([name, c]) => `${c}× **${name}**`)
          .join(", ");
        const failureSummary = Object.entries(itemFailures)
          .map(([name, c]) => `${c}× ${name}`)
          .join(", ");
        const parts = [`📦 opened **${consumed}** loot boxes`];
        if (totalCoins > 0) parts.push(`💰 **+${totalCoins.toLocaleString()}** coins`);
        if (itemSummary) parts.push(`🎁 ${itemSummary}`);
        if (failureSummary) parts.push(`⚠️ db lost: ${failureSummary} (tell the owner, it's logged)`);
        if (owned > consumed) parts.push(`(${owned - consumed} left unopened)`);
        return parts.join(" · ");
      });
    }

    // ─── Adventures ────────────────────────────────────────────────────

    case "adventure_start": {
      const existing = db.getActiveGame(message.channel.id, userId, "adventure");
      if (existing) {
        const step = existing.gameState;
        return `you're already on an adventure! "${step.title}" — step ${step.stepIndex + 1}. choices: ${step.currentChoices.join(", ")}`;
      }

      const adventure = ADVENTURES[Math.floor(Math.random() * ADVENTURES.length)];
      const step = adventure.steps[0];
      const stepChoices = step.choices || [];
      const state = { title: adventure.title, steps: adventure.steps, stepIndex: 0, currentChoices: stepChoices, choiceHistory: [] };
      db.saveActiveGame(message.channel.id, userId, "adventure", state);

      if (!await db.hasAchievement(userId, "adventurer")) await db.unlockAchievement(userId, "adventurer");
      return `**${adventure.title}**\n\n${step.text}\n\nchoices: ${stepChoices.join(", ")}`;
    }

    case "adventure_choice": {
      const game = db.getActiveGame(message.channel.id, userId, "adventure");
      if (!game) return "you're not on an adventure. use adventure_start to begin one";

      const state = game.gameState;
      const choice = (input.choice || "").toLowerCase().trim();
      if (!state.currentChoices.includes(choice)) return `invalid choice. options: ${state.currentChoices.join(", ")}`;

      state.choiceHistory.push(choice);
      const nextIndex = state.stepIndex + 1;

      if (nextIndex >= state.steps.length) {
        // Final step
        const finalStep = state.steps[state.steps.length - 1];
        const rewardRange = finalStep.rewards?.[choice] || [10, 50];
        const coins = randInt(rewardRange[0], rewardRange[1]);
        db.deleteActiveGame(message.channel.id, userId, "adventure");
        if (coins > 0) await db.updateBalance(userId, coins, "adventure", state.title);
        else if (coins < 0) await db.updateBalance(userId, coins, "adventure_loss", state.title);

        const text = typeof finalStep.text === "object" ? (finalStep.text[choice] || "the adventure ends!") : finalStep.text;
        return `${text}\n\nadventure complete! ${coins >= 0 ? `+${coins}` : coins} coins`;
      }

      const nextStep = state.steps[nextIndex];
      const text = typeof nextStep.text === "object" ? (nextStep.text[choice] || "something happens...") : nextStep.text;
      state.stepIndex = nextIndex;
      state.currentChoices = nextStep.choices || [];
      db.saveActiveGame(message.channel.id, userId, "adventure", state);

      if (nextStep.end) {
        const rewardRange = nextStep.rewards?.[choice] || [10, 50];
        const coins = randInt(rewardRange[0], rewardRange[1]);
        db.deleteActiveGame(message.channel.id, userId, "adventure");
        if (coins !== 0) await db.updateBalance(userId, coins, coins >= 0 ? "adventure" : "adventure_loss", state.title);
        return `${text}\n\nadventure complete! ${coins >= 0 ? `+${coins}` : coins} coins`;
      }

      return `${text}\n\nchoices: ${state.currentChoices.join(", ")}`;
    }

    // ─── Prestige ──────────────────────────────────────────────────────

    case "prestige": {
      // Wrap everything in a per-user lock so the check-then-reset can't race
      // against a concurrent earn that credits coins between our balance read
      // and the reset write — old code would still wipe the balance but the
      // race-in coins would vanish without being logged as prestige loss.
      return db.withUserLock(userId, async () => {
        const current = await db.getPrestigeLevel(userId);
        const cost = 5000 * (current + 1);
        const bal = await db.getBalance(userId);
        if (bal.balance < cost) return `need ${cost} coins to prestige to level ${current + 1}. you have ${bal.balance}`;

        // Re-read freshly inside the lock so we reset whatever balance is
        // actually current, not the pre-lock snapshot.
        const freshBal = await db.getBalance(userId);
        // Unsafe variant — outer withUserLock prevents re-entry.
        await db.updateBalanceUnsafe(userId, -freshBal.balance, "prestige", `reset for prestige ${current + 1}`);
        await db.setPrestigeLevel(userId, current + 1);

        if (current + 1 === 1 && !await db.hasAchievement(userId, "prestige_1")) await db.unlockAchievement(userId, "prestige_1");
        if (current + 1 === 5 && !await db.hasAchievement(userId, "prestige_5")) await db.unlockAchievement(userId, "prestige_5");

        return `prestiged to level ${current + 1}! balance reset to 0 but you now get +${(current + 1) * 10}% on all earnings permanently`;
      });
    }

    case "multiplier_check": {
      const { multiplier, breakdown } = await db.getMultipliers(userId);
      if (breakdown.length === 0) return `total multiplier: ${multiplier}x (base). no active boosts`;
      return `total multiplier: ${multiplier.toFixed(2)}x\n${breakdown.map(b => `• ${b}`).join("\n")}`;
    }

    // ─── Marriage ──────────────────────────────────────────────────────

    case "marry": {
      const targetId = await resolveTargetUserId(input, message);
      if (!targetId) return "who do you wanna marry?";
      if (targetId === userId) return "you can't marry yourself weirdo";

      return _queueMarriageOp(async () => {
        // Inside the marriage pipeline — re-read state since another marry/divorce
        // may have completed while we were queued behind it.
        const existing = await db.getMarriage(userId);
        if (existing) return "you're already married! divorce first if you want to marry someone else";
        const targetMarriage = await db.getMarriage(targetId);
        if (targetMarriage) return "they're already married to someone else";

        const bal = await db.getBalance(userId);
        if (bal.balance < 500) return `marriage costs 500 coins. you have ${bal.balance}`;
        const targetBal = await db.getBalance(targetId);
        if (targetBal.balance < 500) return "they can't afford the wedding either (need 500 coins each)";

        const hasRing = await db.hasItem(userId, "Wedding Ring");
        if (!hasRing) return "you need a Wedding Ring from the shop first (500 coins)";

        return `marriage needs consent now. use /marry so <@${targetId}> can accept or decline with buttons`;
      });
    }

    case "divorce": {
      return _queueMarriageOp(async () => {
        const marriage = await db.getMarriage(userId);
        if (!marriage) return "you're not married";
        const partnerId = marriage.user1_id === userId ? marriage.user2_id : marriage.user1_id;

        const bal = await db.getBalance(userId);
        if (bal.balance < 1000) return `divorce costs 1000 coins (alimony). you have ${bal.balance}`;

        await db.updateBalance(userId, -1000, "divorce", "alimony");
        await db.updateBalance(partnerId, 500, "alimony", "divorce settlement");
        invalidateUserCache(partnerId);
        await db.deleteMarriage(userId);

        if (!await db.hasAchievement(userId, "divorced")) await db.unlockAchievement(userId, "divorced");

        return `divorced from <@${partnerId}>. paid 1000 coins (they got 500 in alimony)`;
      });
    }

    case "partner_status": {
      const marriage = await db.getMarriage(userId);
      if (!marriage) return "you're not married";
      const partnerId = marriage.user1_id === userId ? marriage.user2_id : marriage.user1_id;
      const marriedAt = new Date(marriage.married_at);
      const daysTogether = Math.floor((Date.now() - marriedAt.getTime()) / 86_400_000);
      return `married to <@${partnerId}> for ${daysTogether} days. +10% coin bonus active`;
    }

    // ─── Crafting ──────────────────────────────────────────────────────

    case "craft_item": {
      const recipeName = input.recipe || input.item;
      if (!recipeName) return "what do you want to craft? use craft_recipes to see available recipes";

      const recipe = Object.entries(RECIPES).find(([name]) => name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) return `unknown recipe "${recipeName}". use craft_recipes to see options`;

      const [itemName, recipeData] = recipe;

      // Serialize the whole check-and-consume so two parallel crafts can't
      // both pass the ingredient check against the same inventory snapshot
      // and each produce an output while only one full set of ingredients
      // actually gets removed.
      return db.withUserLock(userId, async () => {
        const inv = await db.getInventory(userId);
        const invNames = inv.map(i => i.item_name);

        const missing = [];
        const ingredientCounts = {};
        for (const ing of recipeData.ingredients) {
          ingredientCounts[ing] = (ingredientCounts[ing] || 0) + 1;
        }
        for (const [ing, needed] of Object.entries(ingredientCounts)) {
          const have = invNames.filter(n => n === ing).length;
          if (have < needed) missing.push(`${ing} (need ${needed}, have ${have})`);
        }
        if (missing.length) return `missing ingredients: ${missing.join(", ")}`;

        for (const ing of recipeData.ingredients) {
          if (!await db.removeFromInventory(userId, ing)) return `missing ingredient: ${ing}`;
        }
        await db.addToInventory(userId, itemName, "crafted");
        await db.addDiscoveredRecipe(userId, itemName);

        if (!await db.hasAchievement(userId, "first_craft")) await db.unlockAchievement(userId, "first_craft");
        const discovered = await db.getDiscoveredRecipes(userId);
        if (discovered.length >= Object.keys(RECIPES).length) {
          if (!await db.hasAchievement(userId, "recipe_master")) await db.unlockAchievement(userId, "recipe_master");
        }

        return `crafted **${itemName}**! ${recipeData.description}`;
      });
    }

    case "craft_recipes": {
      const discovered = await db.getDiscoveredRecipes(userId);
      const discoveredNames = new Set(discovered.map(r => r.recipe_name));

      const lines = Object.entries(RECIPES).map(([name, recipe]) => {
        if (discoveredNames.has(name)) {
          return `✅ **${name}**: ${recipe.ingredients.join(" + ")} → ${recipe.description}`;
        }
        return `❓ **${name}**: ??? (undiscovered)`;
      });
      return `recipes:\n${lines.join("\n")}`;
    }

    // ─── Trading ───────────────────────────────────────────────────────

    case "trade_offer": {
      const targetId = await resolveTargetUserId(input, message);
      const offerItem = input.offer_item;
      const wantItem = input.want_item;
      const offerCoins = parseInt(input.offer_coins) || 0;
      const wantCoins = parseInt(input.want_coins) || 0;

      if (!targetId) return "who do you want to trade with?";
      if (!offerItem && !offerCoins) return "you need to offer something (item or coins)";
      if (!wantItem && !wantCoins) return "what do you want in return?";

      if (offerItem) {
        const has = await db.hasItem(userId, offerItem);
        if (!has) return `you don't have a ${offerItem}`;
      }
      if (offerCoins > 0) {
        const bal = await db.getBalance(userId);
        if (bal.balance < offerCoins) return `you only have ${bal.balance} coins`;
      }

      // Store trade as active game so target can accept
      const tradeState = { offerer: userId, target: targetId, offerItem, wantItem, offerCoins, wantCoins };
      db.saveActiveGame(message.channel.id, targetId, "trade", tradeState);

      const offer = [];
      if (offerItem) offer.push(offerItem);
      if (offerCoins) offer.push(`${offerCoins} coins`);
      const want = [];
      if (wantItem) want.push(wantItem);
      if (wantCoins) want.push(`${wantCoins} coins`);

      return `trade offer sent to <@${targetId}>! offering: ${offer.join(" + ")} for: ${want.join(" + ")}. they need to accept`;
    }

    // ─── Pet Battle ────────────────────────────────────────────────────

    case "pet_battle": {
      const targetId = await resolveTargetUserId(input, message);
      if (!targetId) return "who do you want to battle?";
      if (targetId === userId) return "you can't fight yourself";

      const myPet = await db.getPetBattleStats(userId);
      if (!myPet) return "you don't have a pet! use pet_adopt first";
      const theirPet = await db.getPetBattleStats(targetId);
      if (!theirPet) return "they don't have a pet";

      // 3-round battle
      const rounds = [];
      let myHp = 100, theirHp = 100;

      for (let i = 0; i < 3; i++) {
        const myFirst = myPet.speed + randInt(-2, 2) >= theirPet.speed + randInt(-2, 2);
        const attacker1 = myFirst ? myPet : theirPet;
        const defender1 = myFirst ? theirPet : myPet;
        const attacker2 = myFirst ? theirPet : myPet;
        const defender2 = myFirst ? myPet : theirPet;

        const dmg1 = Math.max(1, attacker1.attack + randInt(-3, 3) - Math.floor(defender1.defense / 2));
        const dmg2 = Math.max(1, attacker2.attack + randInt(-3, 3) - Math.floor(defender2.defense / 2));

        if (myFirst) { theirHp -= dmg1; myHp -= dmg2; }
        else { myHp -= dmg1; theirHp -= dmg2; }

        rounds.push(`round ${i + 1}: ${myPet.name} ${myFirst ? "goes first" : "goes second"} — dealt ${myFirst ? dmg1 : dmg2} dmg, took ${myFirst ? dmg2 : dmg1} dmg`);
      }

      const won = myHp > theirHp;
      await db.recordPetBattle(userId, won);
      await db.recordPetBattle(targetId, !won);

      const coins = won ? randInt(20, 80) : 0;
      if (coins > 0) await db.updateBalance(userId, coins, "pet_battle", `vs ${targetId}`);

      if (won && !await db.hasAchievement(userId, "pet_warrior")) await db.unlockAchievement(userId, "pet_warrior");

      return `**Pet Battle: ${myPet.name} vs ${theirPet.name}**\n${rounds.join("\n")}\nfinal: ${myPet.name} ${myHp}hp vs ${theirPet.name} ${theirHp}hp\n${won ? `**${myPet.name} wins!** +${coins} coins` : `**${theirPet.name} wins!** better luck next time`}`;
    }

    case "pet_train": {
      const stat = (input.stat || "").toLowerCase();
      if (!["attack", "defense", "speed"].includes(stat)) return "train what? options: attack, defense, speed";

      // Atomic check-and-set — closes the race where two parallel pet_train
      // calls (e.g. AI re-firing within Promise.all) both pass the cooldown
      // check and both deduct 100 coins.
      const cd = db.tryAcquireCooldown(userId, "pet_train", 3600_000);
      if (cd.onCooldown) return `pet training on cooldown. ${Math.ceil(cd.remainingSec / 60)}min left`;

      const bal = await db.getBalance(userId);
      if (bal.balance < 100) return `training costs 100 coins. you have ${bal.balance}`;

      const result = await db.trainPet(userId, stat);
      if (!result) return "you don't have a pet! use pet_adopt first";

      await db.updateBalance(userId, -100, "pet_train", stat);

      return `trained your pet's ${stat}! +${result.gain} (now ${result.newValue})`;
    }

    // ─── Use Item ──────────────────────────────────────────────────────

    case "use_item": {
      const itemName = input.item || input.item_name;
      if (!itemName) return "what item do you want to use?";
      return db.withUserLock(userId, async () => {
        const has = await db.hasItem(userId, itemName);
        if (!has) return `you don't have a ${itemName}`;

        const consume = async () => {
          const removedType = await db.removeFromInventory(userId, itemName);
          return removedType !== null;
        };

        switch (itemName) {
        case "Lucky Charm": {
          if (!await consume()) return `you don't have a ${itemName}`;
          await db.addToInventory(userId, itemName, "active");
          return "lucky charm activated! +5% gambling luck for 1 hour";
        }
        case "Rob Shield": {
          if (!await consume()) return `you don't have a ${itemName}`;
          await db.addToInventory(userId, itemName, "active");
          return "rob shield activated! you're protected from robbery for 12 hours";
        }
        case "Life Saver": {
          return "life saver is passive — it'll automatically save you from losing coins once";
        }
        case "Double Daily": {
          if (!await consume()) return `you don't have a ${itemName}`;
          await db.addToInventory(userId, itemName, "active");
          return "double daily activated! your next daily reward will be doubled";
        }
        case "XP Boost": {
          if (!await consume()) return `you don't have a ${itemName}`;
          await db.addToInventory(userId, itemName, "active");
          return "xp boost activated! 2x coin earnings from messages for 2 hours";
        }
        case "Mystery Box": {
          if (!await consume()) return `you don't have a ${itemName}`;
          const { openMysteryBox } = await import("./economy.js");
          const result = openMysteryBox();
          await db.updateBalance(userId, result.coins, "mystery_box", result.label);
          return `opened mystery box: ${result.label}`;
        }
        case "Chaos Orb": {
          if (!await consume()) return `you don't have a ${itemName}`;
          const { openMysteryBox: openBox } = await import("./economy.js");
          let total = 0;
          const results = [];
          for (let i = 0; i < 5; i++) {
            const r = openBox();
            total += r.coins;
            results.push(r.label);
          }
          await db.updateBalance(userId, total, "chaos_orb", "5x mystery");
          return `chaos orb opened 5 mystery boxes:\n${results.map(r => `• ${r}`).join("\n")}\ntotal: ${total} coins`;
        }
        case "Pet Armor": {
          const pet = await db.getPetBattleStats(userId);
          if (!pet) return "you don't have a pet";
          if (!await consume()) return `you don't have a ${itemName}`;
          await db.trainPet(userId, "defense"); // +1-3
          return "pet armor equipped! +defense for your pet";
        }
        case "Speed Boots": {
          const pet = await db.getPetBattleStats(userId);
          if (!pet) return "you don't have a pet";
          if (!await consume()) return `you don't have a ${itemName}`;
          await db.trainPet(userId, "speed");
          return "speed boots equipped! +speed for your pet";
        }
        default:
          return `${itemName} doesn't have a use action. it's just a flex item or passive`;
        }
      });
    }

    default:
      return `unknown social tool: ${toolName}`;
  }
}
