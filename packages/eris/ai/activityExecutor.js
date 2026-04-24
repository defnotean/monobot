// ─── Activity Executor: Income & Reward Tools ──────────────────────────────
// fish, hunt, dig, work, beg, search_location, weekly_reward, monthly_reward

import * as db from "../database.js";
import { log } from "../utils/logger.js";

// ─── Loot Tables ───────────────────────────────────────────────────────────

const FISH_TABLE = [
  { name: "Old Boot", rarity: "junk", coins: 1, weight: 15 },
  { name: "Sardine", rarity: "common", coins: 5, weight: 25 },
  { name: "Bass", rarity: "common", coins: 15, weight: 20 },
  { name: "Salmon", rarity: "uncommon", coins: 30, weight: 15 },
  { name: "Tuna", rarity: "uncommon", coins: 50, weight: 10 },
  { name: "Swordfish", rarity: "rare", coins: 100, weight: 7 },
  { name: "Pufferfish", rarity: "rare", coins: 150, weight: 4 },
  { name: "Golden Koi", rarity: "epic", coins: 300, weight: 2.5 },
  { name: "Megalodon Tooth", rarity: "legendary", coins: 500, weight: 1 },
  { name: "Poseidon's Trident", rarity: "mythic", coins: 1000, weight: 0.5 },
];

const ANIMAL_TABLE = [
  { name: "Squirrel", rarity: "common", coins: 3, weight: 25 },
  { name: "Rabbit", rarity: "common", coins: 8, weight: 22 },
  { name: "Fox", rarity: "common", coins: 15, weight: 18 },
  { name: "Deer", rarity: "uncommon", coins: 35, weight: 13 },
  { name: "Wolf", rarity: "uncommon", coins: 60, weight: 9 },
  { name: "Bear", rarity: "rare", coins: 120, weight: 6 },
  { name: "Mountain Lion", rarity: "rare", coins: 200, weight: 4 },
  { name: "Dragon (baby)", rarity: "epic", coins: 400, weight: 2 },
  { name: "Unicorn", rarity: "legendary", coins: 700, weight: 0.8 },
  { name: "Phoenix", rarity: "mythic", coins: 1000, weight: 0.2 },
];

const DIG_TABLE = [
  { name: "nothing", rarity: "junk", coins: 0, weight: 30 },
  { name: "Rusty Nail", rarity: "junk", coins: 2, weight: 10 },
  { name: "Bottle Cap", rarity: "common", coins: 5, weight: 15 },
  { name: "Old Coin", rarity: "common", coins: 15, weight: 12 },
  { name: "Silver Ring", rarity: "uncommon", coins: 40, weight: 10 },
  { name: "Ruby", rarity: "uncommon", coins: 75, weight: 8 },
  { name: "Gold Bar", rarity: "rare", coins: 150, weight: 6 },
  { name: "Diamond", rarity: "rare", coins: 300, weight: 4.5 },
  { name: "Ancient Artifact", rarity: "epic", coins: 500, weight: 2.5 },
  { name: "Buried Treasure Chest", rarity: "legendary", coins: 800, weight: 1.2 },
  { name: "Philosopher's Stone", rarity: "mythic", coins: 1500, weight: 0.8 },
];

const JOB_TABLE = [
  "fast food worker", "janitor", "dog walker", "babysitter", "uber driver",
  "freelance artist", "twitch streamer (0 viewers)", "discord mod (unpaid)",
  "professional sleeper", "cat herder", "meme reviewer", "vibe checker",
  "underwater basket weaver", "professional line-stander", "ghost hunter",
  "fortune cookie writer", "rubber duck debugger", "cloud shape analyst",
];

const BEG_OUTCOMES = [
  { text: "a stranger felt bad for you", coins: [5, 25], weight: 35 },
  { text: "someone threw coins at you", coins: [10, 40], weight: 25 },
  { text: "you found some change on the ground", coins: [1, 10], weight: 20 },
  { text: "a rich person tossed you a bag", coins: [30, 50], weight: 8 },
  { text: "nobody gave you anything. embarrassing", coins: [0, 0], weight: 7 },
  { text: "someone stole from YOU while you were begging lmao", coins: [-20, -5], weight: 5 },
];

const SEARCH_LOCATIONS = [
  { name: "couch cushions", outcomes: [{ coins: [1, 15], chance: 0.7 }, { coins: [0, 0], chance: 0.3, text: "just crumbs" }] },
  { name: "dumpster", outcomes: [{ coins: [5, 30], chance: 0.5 }, { coins: [0, 0], chance: 0.3, text: "just trash" }, { coins: [50, 100], chance: 0.2, text: "someone threw away money??" }] },
  { name: "old car", outcomes: [{ coins: [10, 40], chance: 0.6 }, { coins: [0, 0], chance: 0.4, text: "empty" }] },
  { name: "haunted house", outcomes: [{ coins: [20, 80], chance: 0.4 }, { coins: [-10, -5], chance: 0.3, text: "a ghost scared you and you dropped coins" }, { coins: [100, 200], chance: 0.3, text: "found a ghost's treasure stash" }] },
  { name: "school locker", outcomes: [{ coins: [5, 20], chance: 0.6 }, { coins: [0, 0], chance: 0.4, text: "just old textbooks" }] },
  { name: "dog park", outcomes: [{ coins: [3, 15], chance: 0.5 }, { coins: [0, 0], chance: 0.3, text: "just dogs" }, { coins: [20, 50], chance: 0.2, text: "a dog brought you something shiny" }] },
  { name: "sewer", outcomes: [{ coins: [15, 60], chance: 0.4 }, { coins: [-5, -1], chance: 0.3, text: "you slipped and lost coins" }, { coins: [80, 150], chance: 0.3, text: "found a wallet someone dropped" }] },
  { name: "area 51", outcomes: [{ coins: [50, 200], chance: 0.2 }, { coins: [-30, -10], chance: 0.4, text: "the government fined you for trespassing" }, { coins: [200, 500], chance: 0.1, text: "alien technology!! sold it for a fortune" }, { coins: [0, 0], chance: 0.3, text: "nothing but conspiracy theorists" }] },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function weightedRandom(table) {
  const totalWeight = table.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of table) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return table[table.length - 1];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rarityEmoji(rarity) {
  const map = { junk: "🗑️", common: "⚪", uncommon: "🟢", rare: "🔵", epic: "🟣", legendary: "🟡", mythic: "🔴" };
  return map[rarity] || "⚪";
}

async function applyMultiplier(userId, baseCoins) {
  if (baseCoins <= 0) return baseCoins;
  const result = await db.getMultipliers(userId);
  // Defensive fallback: a malformed result (undefined/NaN) used to propagate
  // NaN through updateBalance and corrupt coin totals. Fall back to base.
  const multiplier = Number(result?.multiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return baseCoins;
  return Math.floor(baseCoins * multiplier);
}

// ─── Main Executor ─────────────────────────────────────────────────────────

export async function executeActivityTool(toolName, input, message) {
  const userId = message.author.id;
  log(`[ACTIVITY] Executing: ${toolName} for ${userId} | channel: ${message.channel?.id || "none"}`);

  switch (toolName) {

    case "fish": {
      const cd = db.tryAcquireCooldown(userId, "fish", 30_000);
      if (cd.onCooldown) return `fishing on cooldown. ${cd.remainingSec}s left`;

      const hasRod = await db.hasItem(userId, "Fishing Rod");
      let catch_ = weightedRandom(FISH_TABLE);
      // Rod boosts: reroll junk once
      if (hasRod && catch_.rarity === "junk") catch_ = weightedRandom(FISH_TABLE);

      const coins = await applyMultiplier(userId, catch_.coins);
      if (coins > 0) await db.updateBalance(userId, coins, "fish", catch_.name);
      await db.recordGameResult(userId, "fish", coins > 0, 0, coins);

      if (!await db.hasAchievement(userId, "first_fish")) await db.unlockAchievement(userId, "first_fish");
      if (catch_.rarity === "legendary" || catch_.rarity === "mythic") {
        if (!await db.hasAchievement(userId, "legendary_fisher")) await db.unlockAchievement(userId, "legendary_fisher");
      }

      // Send animated embed with "Again" button
      const { activityEmbed, activityAnimFrames, animateEmbed } = await import("./gameVisuals.js");
      const bal = await db.getBalance(userId);
      const resultEmbed = activityEmbed("Fish", `caught a **${catch_.name}** (${catch_.rarity})!`, coins, catch_.rarity, bal.balance, "🎣");
      const frames = [...activityAnimFrames("Fish", "🎣"), { embed: resultEmbed.embed, components: [resultEmbed.row] }];
      try {
        await animateEmbed(message.channel, frames, 800);
      } catch (e) {
        log(`[ACTIVITY] Fish embed failed: ${e.message}`);
        return `caught a **${catch_.name}** (${catch_.rarity})! +${coins} coins. balance: ${bal.balance}`;
      }
      return "[game started]";
    }

    case "hunt": {
      const cd = db.tryAcquireCooldown(userId, "hunt", 45_000);
      if (cd.onCooldown) return `hunting on cooldown. ${cd.remainingSec}s left`;

      const hasRifle = await db.hasItem(userId, "Hunting Rifle");
      let animal = weightedRandom(ANIMAL_TABLE);
      if (hasRifle && animal.rarity === "common") animal = weightedRandom(ANIMAL_TABLE);

      const coins = await applyMultiplier(userId, animal.coins);
      if (coins > 0) await db.updateBalance(userId, coins, "hunt", animal.name);
      await db.recordGameResult(userId, "hunt", coins > 0, 0, coins);

      if (!await db.hasAchievement(userId, "first_hunt")) await db.unlockAchievement(userId, "first_hunt");

      const { activityEmbed, activityAnimFrames, animateEmbed } = await import("./gameVisuals.js");
      const bal = await db.getBalance(userId);
      const re = activityEmbed("Hunt", `caught a **${animal.name}** (${animal.rarity})!`, coins, animal.rarity, bal.balance, "🏹");
      const frames = [...activityAnimFrames("Hunt", "🏹"), { embed: re.embed, components: [re.row] }];
      try { await animateEmbed(message.channel, frames, 800); } catch (e) {
        log(`[ACTIVITY] Hunt embed failed: ${e.message}`);
        return `caught a **${animal.name}** (${animal.rarity})! +${coins} coins. balance: ${bal.balance}`;
      }
      return "[game started]";
    }

    case "dig": {
      const cd = db.tryAcquireCooldown(userId, "dig", 30_000);
      if (cd.onCooldown) return `digging on cooldown. ${cd.remainingSec}s left`;

      const hasDetector = await db.hasItem(userId, "Metal Detector");
      let find = weightedRandom(DIG_TABLE);
      if (hasDetector && find.rarity === "junk") find = weightedRandom(DIG_TABLE);

      const coins = await applyMultiplier(userId, find.coins);
      if (coins > 0) await db.updateBalance(userId, coins, "dig", find.name);

      if (find.rarity === "legendary" || find.rarity === "mythic") {
        if (!await db.hasAchievement(userId, "treasure_hunter")) await db.unlockAchievement(userId, "treasure_hunter");
      }

      const { activityEmbed: digEm, activityAnimFrames: digFr, animateEmbed: digAn } = await import("./gameVisuals.js");
      const bal = await db.getBalance(userId);
      const desc = find.name === "nothing" ? "found... nothing. just dirt" : `dug up a **${find.name}** (${find.rarity})!`;
      const re = digEm("Dig", desc, coins, find.rarity || "junk", bal.balance, "⛏️");
      const frames = [...digFr("Dig", "⛏️"), { embed: re.embed, components: [re.row] }];
      try { await digAn(message.channel, frames, 800); } catch (e) {
        log(`[ACTIVITY] Dig embed failed: ${e.message}`);
        return `${desc} +${coins} coins. balance: ${bal.balance}`;
      }
      return "[game started]";
    }

    case "work": {
      const cd = db.tryAcquireCooldown(userId, "work", 30 * 60_000);
      if (cd.onCooldown) return `you already worked recently. ${Math.ceil(cd.remainingSec / 60)}min left`;

      const job = JOB_TABLE[Math.floor(Math.random() * JOB_TABLE.length)];
      const base = randInt(50, 200);
      const coins = await applyMultiplier(userId, base);
      await db.updateBalance(userId, coins, "work", job);

      if (!await db.hasAchievement(userId, "hard_worker")) await db.unlockAchievement(userId, "hard_worker");

      const { activityEmbed: workEm, activityAnimFrames: workFr, animateEmbed: workAn } = await import("./gameVisuals.js");
      const bal = await db.getBalance(userId);
      const re = workEm("Work", `worked as a **${job}**`, coins, "common", bal.balance, "💼");
      const frames = [...workFr("Work", "💼"), { embed: re.embed, components: [re.row] }];
      try { await workAn(message.channel, frames, 800); } catch (e) {
        log(`[ACTIVITY] Work embed failed: ${e.message}`);
        return `worked as a **${job}**. +${coins} coins. balance: ${bal.balance}`;
      }
      return "[game started]";
    }

    case "beg": {
      const cd = db.tryAcquireCooldown(userId, "beg", 30_000);
      if (cd.onCooldown) return `begging on cooldown. ${cd.remainingSec}s left`;

      const outcome = weightedRandom(BEG_OUTCOMES);
      const coins = randInt(outcome.coins[0], outcome.coins[1]);
      if (coins !== 0) await db.updateBalance(userId, coins, "beg", outcome.text);

      const { activityEmbed, animateEmbed } = await import("./gameVisuals.js");
      const bal = await db.getBalance(userId);
      const rarity = coins > 20 ? "uncommon" : coins > 0 ? "common" : "junk";
      const { embed: begE, row: begR } = activityEmbed("Beg", outcome.text, Math.abs(coins), rarity, bal.balance, "🙏");
      await message.channel.send({ embeds: [begE], components: [begR] });
      return "[game started]";
    }

    case "search_location": {
      const cd = db.tryAcquireCooldown(userId, "search_location", 20_000);
      if (cd.onCooldown) return `searching on cooldown. ${cd.remainingSec}s left`;

      const location = SEARCH_LOCATIONS[Math.floor(Math.random() * SEARCH_LOCATIONS.length)];
      let roll = Math.random();
      let result = null;
      for (const outcome of location.outcomes) {
        roll -= outcome.chance;
        if (roll <= 0) { result = outcome; break; }
      }
      if (!result) result = location.outcomes[location.outcomes.length - 1];

      const coins = randInt(result.coins[0], result.coins[1]);
      if (coins !== 0) await db.updateBalance(userId, coins, "search", location.name);

      const desc = result.text || (coins > 0 ? "found some coins" : "found nothing");
      const coinsStr = coins > 0 ? ` +${coins} coins` : coins < 0 ? ` ${coins} coins` : "";
      return `you searched the **${location.name}** — ${desc}${coinsStr}`;
    }

    case "weekly_reward": {
      const result = await db.claimWeekly(userId);
      if (!result.success) {
        const hours = result.hoursLeft;
        const days = Math.floor(hours / 24);
        const h = hours % 24;
        return `weekly already claimed. come back in ${days > 0 ? `${days}d ` : ""}${h}h`;
      }
      return `weekly claimed! +${result.coins} coins (streak: ${result.streak} weeks). balance: ${result.newBalance}`;
    }

    case "monthly_reward": {
      const result = await db.claimMonthly(userId);
      if (!result.success) {
        const hours = result.hoursLeft;
        const days = Math.floor(hours / 24);
        return `monthly already claimed. come back in ${days}d`;
      }
      return `monthly claimed! +${result.coins} coins (streak: ${result.streak} months). balance: ${result.newBalance}`;
    }

    default:
      return `unknown activity tool: ${toolName}`;
  }
}

// ─── In-Place Activity Executor (for "Again" buttons — edits existing embed) ──

export async function executeActivityToolInPlace(toolName, userId, interaction) {
  const { activityEmbed, activityAnimFrames, animateEmbedEdit } = await import("./gameVisuals.js");

  switch (toolName) {
    case "fish": {
      const cd = db.tryAcquireCooldown(userId, "fish", 30_000);
      if (cd.onCooldown) return interaction.reply({ content: `fishing on cooldown. ${cd.remainingSec}s left`, flags: 64 });

      const hasRod = await db.hasItem(userId, "Fishing Rod");
      let catch_ = weightedRandom(FISH_TABLE);
      if (hasRod && catch_.rarity === "junk") catch_ = weightedRandom(FISH_TABLE);

      const coins = await applyMultiplier(userId, catch_.coins);
      if (coins > 0) await db.updateBalance(userId, coins, "fish", catch_.name);
      await db.recordGameResult(userId, "fish", coins > 0, 0, coins);

      const bal = await db.getBalance(userId);
      const frames = [...activityAnimFrames("Fish", "🎣"), { embed: activityEmbed("Fish", `caught a **${catch_.name}** (${catch_.rarity})!`, coins, catch_.rarity, bal.balance, "🎣").embed, components: [activityEmbed("Fish", "", coins, catch_.rarity, bal.balance, "🎣").row] }];
      await animateEmbedEdit(interaction, frames, 800);
      return;
    }

    case "hunt": {
      const cd = db.tryAcquireCooldown(userId, "hunt", 45_000);
      if (cd.onCooldown) return interaction.reply({ content: `hunting on cooldown. ${cd.remainingSec}s left`, flags: 64 });

      const hasRifle = await db.hasItem(userId, "Hunting Rifle");
      let animal = weightedRandom(ANIMAL_TABLE);
      if (hasRifle && animal.rarity === "common") animal = weightedRandom(ANIMAL_TABLE);

      const coins = await applyMultiplier(userId, animal.coins);
      if (coins > 0) await db.updateBalance(userId, coins, "hunt", animal.name);
      await db.recordGameResult(userId, "hunt", coins > 0, 0, coins);

      const bal = await db.getBalance(userId);
      const frames = [...activityAnimFrames("Hunt", "🏹"), { embed: activityEmbed("Hunt", `caught a **${animal.name}** (${animal.rarity})!`, coins, animal.rarity, bal.balance, "🏹").embed, components: [activityEmbed("Hunt", "", coins, animal.rarity, bal.balance, "🏹").row] }];
      await animateEmbedEdit(interaction, frames, 800);
      return;
    }

    case "dig": {
      const cd = db.tryAcquireCooldown(userId, "dig", 30_000);
      if (cd.onCooldown) return interaction.reply({ content: `digging on cooldown. ${cd.remainingSec}s left`, flags: 64 });

      const hasDetector = await db.hasItem(userId, "Metal Detector");
      let find = weightedRandom(DIG_TABLE);
      if (hasDetector && find.rarity === "junk") find = weightedRandom(DIG_TABLE);

      const coins = await applyMultiplier(userId, find.coins);
      if (coins > 0) await db.updateBalance(userId, coins, "dig", find.name);

      const bal = await db.getBalance(userId);
      const desc = find.name === "nothing" ? "found... nothing. just dirt" : `dug up a **${find.name}** (${find.rarity})!`;
      const frames = [...activityAnimFrames("Dig", "⛏️"), { embed: activityEmbed("Dig", desc, coins, find.rarity || "junk", bal.balance, "⛏️").embed, components: [activityEmbed("Dig", "", coins, find.rarity || "junk", bal.balance, "⛏️").row] }];
      await animateEmbedEdit(interaction, frames, 800);
      return;
    }

    case "work": {
      const cd = db.tryAcquireCooldown(userId, "work", 30 * 60_000);
      if (cd.onCooldown) return interaction.reply({ content: `you already worked recently. ${Math.ceil(cd.remainingSec / 60)}min left`, flags: 64 });

      const job = JOB_TABLE[Math.floor(Math.random() * JOB_TABLE.length)];
      const base = randInt(50, 200);
      const coins = await applyMultiplier(userId, base);
      await db.updateBalance(userId, coins, "work", job);

      const bal = await db.getBalance(userId);
      const frames = [...activityAnimFrames("Work", "💼"), { embed: activityEmbed("Work", `worked as a **${job}**`, coins, "common", bal.balance, "💼").embed, components: [activityEmbed("Work", "", coins, "common", bal.balance, "💼").row] }];
      await animateEmbedEdit(interaction, frames, 800);
      return;
    }

    case "beg": {
      const cd = db.tryAcquireCooldown(userId, "beg", 30_000);
      if (cd.onCooldown) return interaction.reply({ content: `begging on cooldown. ${cd.remainingSec}s left`, flags: 64 });

      const outcome = weightedRandom(BEG_OUTCOMES);
      const coins = randInt(outcome.coins[0], outcome.coins[1]);
      if (coins !== 0) await db.updateBalance(userId, coins, "beg", outcome.text);

      const bal = await db.getBalance(userId);
      const rarity = coins > 20 ? "uncommon" : coins > 0 ? "common" : "junk";
      const { embed, row } = activityEmbed("Beg", outcome.text, Math.abs(coins), rarity, bal.balance, "🙏");
      return interaction.update({ embeds: [embed], components: [row] });
    }

    default:
      return interaction.reply({ content: "cooldown or error — try again in a sec", flags: 64 });
  }
}
