// ─── Economy Helpers: Achievements, Challenges, Loans, Shop ─────────────────

// ─── Achievement Definitions ────────────────────────────────────────────────

export const ACHIEVEMENTS = {
  // Gambling
  first_bet:       { name: "Baby's First Bet", desc: "place your first gamble", icon: "🎰" },
  high_roller:     { name: "High Roller", desc: "bet 500+ coins in a single game", icon: "💎" },
  jackpot:         { name: "JACKPOT!", desc: "hit a 10x+ payout on slots", icon: "🎰" },
  broke:           { name: "Down Bad", desc: "reach 0 coins", icon: "💸" },
  rich:            { name: "Loaded", desc: "reach 5000 coins", icon: "🤑" },
  mega_rich:       { name: "Eris's Favorite", desc: "reach 10000 coins", icon: "👑" },
  streak_3:        { name: "Hot Streak", desc: "win 3 games in a row", icon: "🔥" },
  streak_5:        { name: "On Fire", desc: "win 5 games in a row", icon: "🔥🔥" },
  streak_10:       { name: "Unstoppable", desc: "win 10 games in a row", icon: "🌟" },
  // Social
  first_rob:       { name: "Petty Criminal", desc: "successfully rob someone", icon: "🦹" },
  rob_fail_3:      { name: "World's Worst Thief", desc: "fail a robbery 3 times", icon: "🤡" },
  first_duel:      { name: "Duelist", desc: "win your first duel", icon: "⚔️" },
  cursed:          { name: "Cursed", desc: "get cursed by eris", icon: "💀" },
  // Economy
  daily_7:         { name: "Dedicated", desc: "claim daily reward 7 days in a row", icon: "📅" },
  daily_30:        { name: "No Life", desc: "claim daily reward 30 days in a row", icon: "📆" },
  first_purchase:  { name: "Consumer", desc: "buy your first shop item", icon: "🛒" },
  loan_shark:      { name: "In Debt", desc: "take out your first loan", icon: "🦈" },
  loan_paid:       { name: "Responsible", desc: "pay back a loan on time", icon: "✅" },
  loan_defaulted:  { name: "Deadbeat", desc: "default on a loan", icon: "💀" },
  bounty_hunter:   { name: "Bounty Hunter", desc: "collect a bounty", icon: "🎯" },
  bounty_target:   { name: "Wanted", desc: "have a bounty placed on you", icon: "🎯" },
  // Games
  trivia_10:       { name: "Nerd", desc: "answer 10 trivia questions correctly", icon: "🧠" },
  roulette_survive:{ name: "Lucky", desc: "survive russian roulette 5 times", icon: "🔫" },
  blackjack_21:    { name: "Twenty-One", desc: "get a natural blackjack", icon: "🃏" },
  // Income & Activities
  first_fish:      { name: "Gone Fishing", desc: "catch your first fish", icon: "🎣" },
  legendary_fisher:{ name: "Master Angler", desc: "catch a legendary or mythic fish", icon: "🐟" },
  first_hunt:      { name: "Hunter", desc: "hunt your first animal", icon: "🏹" },
  treasure_hunter: { name: "Treasure Hunter", desc: "dig up a legendary treasure", icon: "💰" },
  hard_worker:     { name: "Employee of the Month", desc: "complete your first work shift", icon: "💼" },
  // Banking & Prestige
  first_deposit:   { name: "Saver", desc: "make your first bank deposit", icon: "🏦" },
  full_bank:       { name: "Bank's Full", desc: "fill your bank to capacity", icon: "🏦" },
  prestige_1:      { name: "Prestige I", desc: "reach prestige level 1", icon: "⭐" },
  prestige_5:      { name: "Prestige V", desc: "reach prestige level 5", icon: "🌟" },
  // Social
  just_married:    { name: "Just Married", desc: "get married", icon: "💍" },
  divorced:        { name: "It's Complicated", desc: "get divorced", icon: "💔" },
  generous:        { name: "Generous", desc: "give coins to someone", icon: "🎁" },
  // Crafting
  first_craft:     { name: "Crafter", desc: "craft your first item", icon: "🔨" },
  recipe_master:   { name: "Recipe Master", desc: "discover all recipes", icon: "📖" },
  // Pet Battles
  pet_warrior:     { name: "Pet Warrior", desc: "win a pet battle", icon: "⚔️" },
  // Adventures
  adventurer:      { name: "Adventurer", desc: "start your first adventure", icon: "🗺️" },
};

/**
 * Check if a user has unlocked an achievement.
 */
export function checkAchievementCondition(key, context) {
  switch (key) {
    case "first_bet": return context.totalGambled > 0;
    case "high_roller": return context.lastBet >= 500;
    case "broke": return context.balance <= 0;
    case "rich": return context.balance >= 5000;
    case "mega_rich": return context.balance >= 10000;
    case "streak_3": return context.currentStreak >= 3;
    case "streak_5": return context.currentStreak >= 5;
    case "streak_10": return context.currentStreak >= 10;
    case "daily_7": return context.dailyStreak >= 7;
    case "daily_30": return context.dailyStreak >= 30;
    case "trivia_10": return context.triviaCorrect >= 10;
    case "roulette_survive": return context.rouletteSurvived >= 5;
    case "first_fish": return context.fishCaught > 0;
    case "first_hunt": return context.animalsCaught > 0;
    case "hard_worker": return context.jobsWorked > 0;
    case "first_deposit": return context.bankDeposits > 0;
    default: return false; // event-triggered achievements (rob, duel, etc.) are checked inline
  }
}

// ─── Daily Challenge Templates ──────────────────────────────────────────────

export const CHALLENGE_TEMPLATES = [
  { type: "coinflip_wins", desc: "Win {target} coinflips", target: [2, 3, 4], reward: [100, 200, 350] },
  { type: "dice_wins", desc: "Win {target} dice rolls", target: [1, 2], reward: [150, 300] },
  { type: "slots_play", desc: "Spin the slots {target} times", target: [3, 5, 10], reward: [75, 150, 300] },
  { type: "rps_wins", desc: "Win {target} RPS games", target: [2, 3, 5], reward: [80, 150, 300] },
  { type: "trivia_correct", desc: "Answer {target} trivia questions correctly", target: [2, 3, 5], reward: [100, 200, 400] },
  { type: "total_wagered", desc: "Wager a total of {target} coins", target: [200, 500, 1000], reward: [100, 200, 400] },
  { type: "rob_attempt", desc: "Attempt {target} robberies (success or fail)", target: [1, 2, 3], reward: [100, 200, 350] },
  { type: "duel_wins", desc: "Win {target} duels", target: [1, 2], reward: [150, 300] },
  { type: "earn_coins", desc: "Earn {target} coins total today", target: [200, 500, 1000], reward: [100, 200, 400] },
  { type: "survive_roulette", desc: "Survive russian roulette {target} times", target: [1, 2, 3], reward: [150, 300, 500] },
];

/**
 * Generate a random daily challenge.
 */
export function generateChallenge() {
  const template = CHALLENGE_TEMPLATES[Math.floor(Math.random() * CHALLENGE_TEMPLATES.length)];
  const diffIdx = Math.floor(Math.random() * template.target.length);
  return {
    type: template.type,
    description: template.desc.replace("{target}", String(template.target[diffIdx])),
    target: template.target[diffIdx],
    reward: template.reward[diffIdx],
  };
}

// ─── Default Shop Items ─────────────────────────────────────────────────────

export const DEFAULT_SHOP_ITEMS = [
  // ── EQUIPMENT (activity tools) ──
  { name: "Fishing Rod", type: "equipment", price: 500, description: "Better chance of rare fish", emoji: "🎣" },
  { name: "Hunting Rifle", type: "equipment", price: 500, description: "Better chance of rare animals", emoji: "🔫" },
  { name: "Metal Detector", type: "equipment", price: 750, description: "Better chance of rare digs", emoji: "📡" },
  { name: "Enchanted Rod", type: "equipment", price: 2500, description: "Greatly boosts mythic fish chance", requires: "Fishing Rod", emoji: "✨" },
  { name: "Dragon Bow", type: "equipment", price: 2500, description: "Greatly boosts phoenix/dragon encounter rate", requires: "Hunting Rifle", emoji: "🏹" },
  { name: "Excavation Drill", type: "equipment", price: 3000, description: "Doubles ancient artifact drop rate", requires: "Metal Detector", emoji: "⛏️" },
  { name: "Explorer's Map", type: "equipment", price: 1500, description: "Doubles rare event trigger chance during activities", emoji: "🗺️" },
  { name: "Streak Shield", type: "equipment", price: 800, description: "Prevents activity streak from resetting for 1 hour", emoji: "🔥" },

  // ── CONSUMABLES (single use) ──
  { name: "Mystery Box", type: "mystery", price: 150, description: "Could be 10 coins or 1000... who knows", emoji: "📦" },
  { name: "Loot Box", type: "mystery", price: 200, description: "Random loot — could be anything", emoji: "🎁" },
  { name: "Golden Loot Box", type: "mystery", price: 1000, description: "Guaranteed 500+ coins with a chance at 5000", emoji: "✨" },
  { name: "Life Saver", type: "passive", price: 1000, description: "Prevents coin loss once (auto-use)", emoji: "🛟" },
  { name: "Padlock", type: "passive", price: 300, description: "Blocks one robbery attempt", emoji: "🔒" },
  { name: "Smoke Bomb", type: "consumable", price: 400, description: "Auto-escape one failed robbery (no fine)", emoji: "💨" },
  { name: "Coin Bomb", type: "consumable", price: 600, description: "Explodes for 100-800 random coins to everyone in chat", emoji: "💣" },
  { name: "Reroll Token", type: "consumable", price: 250, description: "Re-spin your last slots result (keeps better outcome)", emoji: "🔄" },
  { name: "Double or Nothing", type: "consumable", price: 500, description: "Next gamble win pays 2x (consumed on any gamble)", emoji: "⚡" },
  { name: "Cooldown Reset", type: "consumable", price: 350, description: "Instantly reset one activity cooldown", emoji: "⏰" },
  { name: "Boss Summon Scroll", type: "consumable", price: 300, description: "Reduces boss spawn cost from 500 to 200 (one use)", emoji: "📜" },

  // ── BOOSTERS (temporary buffs) ──
  { name: "Double Daily", type: "booster", price: 300, description: "Your next daily reward is doubled", emoji: "📦" },
  { name: "Lucky Charm", type: "booster", price: 750, description: "+5% luck on all gambling for 1 hour", emoji: "🍀" },
  { name: "XP Boost", type: "booster", price: 350, description: "2x coin earning from messages for 2 hours", emoji: "⭐" },
  { name: "Grinder's Potion", type: "booster", price: 600, description: "Activity cooldowns halved for 30 minutes", emoji: "⚗️" },
  { name: "Fortune Cookie", type: "booster", price: 200, description: "Reveals a hint about the next random event", emoji: "🥠" },
  { name: "Adrenaline Shot", type: "booster", price: 500, description: "+15% gambling luck for 15 minutes (stacks with Lucky Charm)", emoji: "💉" },
  { name: "Pet Treat", type: "booster", price: 150, description: "Fully restores pet hunger and mood", requires: "pet", emoji: "🦴" },
  { name: "Training Manual", type: "booster", price: 400, description: "Next pet training gives +5 instead of +1-3", requires: "pet", emoji: "📚" },
  { name: "Battle Ration", type: "booster", price: 300, description: "+20% pet stats for next battle", requires: "pet", emoji: "🥩" },
  { name: "Streak Potion", type: "booster", price: 450, description: "Starts your next activity at streak 5 instantly", emoji: "🧪" },

  // ── PROTECTIONS ──
  { name: "Rob Shield", type: "shield", price: 400, description: "Can't be robbed for 12 hours", emoji: "🛡️" },
  { name: "Insurance Policy", price: 800, type: "protection", description: "Recovers 50% of losses on next gamble loss (single use)", emoji: "📋" },
  { name: "Bank Vault Upgrade", price: 1500, type: "protection", description: "+5000 bank capacity", emoji: "🏦" },
  { name: "Bodyguard", price: 2000, type: "protection", description: "Blocks ALL robberies for 24h", emoji: "🕶️" },
  { name: "Tax Exemption", price: 1000, type: "protection", description: "Immune to random tax events for 48h", emoji: "📄" },
  { name: "Curse Immunity", type: "immunity", price: 500, description: "Immune to curses for 24 hours", emoji: "🧿" },
  { name: "Phantom Cloak", price: 1200, type: "protection", description: "Hidden from phantom thief events for 24h", emoji: "👻" },
  { name: "Decoy Wallet", price: 600, type: "protection", description: "Robbers steal from the decoy instead (-0 coins, one use)", emoji: "👛" },
  { name: "Fireproof Safe", price: 3500, type: "protection", description: "Bank coins can't be lost to any event (permanent)", emoji: "🔐" },

  // ── UPGRADES (permanent) ──
  { name: "Coin Magnet", price: 2000, type: "upgrade", description: "+5% passive earnings permanently", effect: "coin_magnet", emoji: "🧲" },
  { name: "Lucky Aura", price: 3000, type: "upgrade", description: "+2% gambling luck permanently", effect: "lucky_aura", emoji: "🌟" },
  { name: "Thick Skin", price: 1500, type: "upgrade", description: "Robbery losses reduced by 20%", effect: "thick_skin", emoji: "🦏" },
  { name: "Quick Hands", price: 2500, type: "upgrade", description: "All cooldowns reduced by 10%", effect: "quick_hands", emoji: "⚡" },
  { name: "Deep Pockets", price: 4000, type: "upgrade", description: "+10% to all activity earnings permanently", effect: "deep_pockets", emoji: "👖" },
  { name: "Gambler's Instinct", price: 5000, type: "upgrade", description: "+5% gambling luck permanently (stacks with Lucky Aura)", effect: "gamblers_instinct", emoji: "🎰" },
  { name: "Iron Will", price: 3500, type: "upgrade", description: "Gambling losses capped at 80% of bet (always keep 20%)", effect: "iron_will", emoji: "🧠" },
  { name: "Pet Affinity", price: 2000, type: "upgrade", description: "Pet training gains +1 per session permanently", effect: "pet_affinity", emoji: "🐾" },
  { name: "Boss Slayer", price: 4000, type: "upgrade", description: "+25% damage in boss battles permanently", effect: "boss_slayer", emoji: "💀" },
  { name: "Streak Master", price: 3000, type: "upgrade", description: "Activity streaks decay 2x slower", effect: "streak_master", emoji: "🔥" },
  { name: "Merchant's Eye", price: 2500, type: "upgrade", description: "10% discount on all future shop purchases", effect: "merchants_eye", emoji: "👁️" },
  { name: "Fortune Favored", price: 6000, type: "upgrade", description: "Rare activity events trigger 2x more often", effect: "fortune_favored", emoji: "🌈" },

  // ── PET ITEMS ──
  { name: "Pet Armor", price: 1500, type: "pet_gear", description: "+5 DEF for your pet permanently", stat: "defense", bonus: 5, requires: "pet", emoji: "🛡️" },
  { name: "Pet Weapon", price: 1500, type: "pet_gear", description: "+5 ATK for your pet permanently", stat: "attack", bonus: 5, requires: "pet", emoji: "⚔️" },
  { name: "Pet Boots", price: 1500, type: "pet_gear", description: "+5 SPD for your pet permanently", stat: "speed", bonus: 5, requires: "pet", emoji: "👟" },
  { name: "Evolution Stone", price: 5000, type: "pet_gear", description: "Reduces pet evolution level requirement by 3", requires: "pet", emoji: "💎" },
  { name: "Pet Revive", price: 800, type: "pet_gear", description: "Fully heals pet after a lost battle (hunger + mood to 100)", requires: "pet", emoji: "💊" },
  { name: "Shiny Collar", price: 2000, type: "pet_cosmetic", description: "Your pet gets a ✨ in battle displays", requires: "pet", emoji: "✨" },
  { name: "War Paint", price: 1200, type: "pet_cosmetic", description: "Your pet gets a 🔥 in battle displays", requires: "pet", emoji: "🎨" },
  { name: "XP Collar", price: 2500, type: "pet_gear", description: "Pet earns 2x XP from all sources permanently", requires: "pet", emoji: "⭐" },

  // ── COSMETICS (flex) ──
  { name: "Flex Badge", type: "cosmetic", price: 1000, description: "A shiny badge next to your name on the leaderboard", emoji: "🏅" },
  { name: "Diamond Title", price: 5000, type: "cosmetic", description: "💎 badge on leaderboard", badge: "💎", emoji: "💎" },
  { name: "Fire Title", price: 3000, type: "cosmetic", description: "🔥 badge on leaderboard", badge: "🔥", emoji: "🔥" },
  { name: "Crown Title", price: 10000, type: "cosmetic", description: "👑 badge on leaderboard", badge: "👑", emoji: "👑" },
  { name: "Name Glow", price: 4000, type: "cosmetic", description: "✨ around name on leaderboard", badge: "✨", emoji: "✨" },
  { name: "Skull Title", price: 7500, type: "cosmetic", description: "💀 badge on leaderboard (edgy)", badge: "💀", emoji: "💀" },
  { name: "Galaxy Title", price: 15000, type: "cosmetic", description: "🌌 ultra-rare leaderboard badge", badge: "🌌", emoji: "🌌" },
  { name: "Custom Color", price: 8000, type: "cosmetic", description: "Choose a custom embed color for your profile", emoji: "🎨" },
  { name: "Animated Name", price: 12000, type: "cosmetic", description: "Your name sparkles on the leaderboard", badge: "⚡", emoji: "⚡" },
  { name: "Shadow Aura", price: 20000, type: "cosmetic", description: "🖤 the rarest flex — dark aura on leaderboard", badge: "🖤", emoji: "🖤" },

  // ── SOCIAL ──
  { name: "Nickname Change", type: "nickname", price: 200, description: "Change someone's nickname for 1 hour", emoji: "📝" },
  { name: "Wedding Ring", type: "special", price: 500, description: "Required for marriage proposals", emoji: "💍" },
  { name: "Divorce Papers", type: "special", price: 1000, description: "End your marriage (both lose the 10% bonus)", emoji: "📃" },
  { name: "Love Letter", type: "special", price: 300, description: "Send a love letter to another user (+5 affinity)", emoji: "💌" },
  { name: "Duel Banner", type: "special", price: 750, description: "Custom title displayed when you win duels", emoji: "🏴" },
  { name: "Bounty Poster", type: "special", price: 500, description: "Put a 500-coin bounty on someone's head", emoji: "🎯" },
  { name: "Gift Box", type: "special", price: 100, description: "Wrap coins to send as a gift (transferable)", emoji: "🎁" },

  // ── GAMBLING SPECIALS ──
  { name: "Loaded Dice", type: "gambling", price: 2000, description: "Next dice roll has 2 guesses instead of 1", emoji: "🎲" },
  { name: "Slot Token", type: "gambling", price: 1500, description: "One free slot spin (no coin risk, keep winnings)", emoji: "🎰" },
  { name: "Card Counter", type: "gambling", price: 1800, description: "See the dealer's hidden card in blackjack (one game)", emoji: "🃏" },
  { name: "Rigged Coin", type: "gambling", price: 1200, description: "Next coinflip has 70% win chance instead of 50%", emoji: "🪙" },
  { name: "Jackpot Ticket", type: "gambling", price: 3000, description: "If you hit triple 7s in slots, payout is 100x instead of 50x", emoji: "🎟️" },
  { name: "Safety Net", type: "gambling", price: 600, description: "If your next gamble loses, get 50% back", emoji: "🕸️" },

  // ── MINIONS ──
  { name: "Minion Worker", price: 1000, type: "minion", description: "⛏️ Hire a worker — earns 5-15 coins every 30 min", minionType: "worker", emoji: "⛏️" },
  { name: "Minion Miner", price: 2000, type: "minion", description: "💎 Hire a miner — earns 10-30 coins every 30 min", minionType: "miner", emoji: "💎" },
  { name: "Minion Thief", price: 3000, type: "minion", description: "🦹 Hire a thief — steals 5-20 coins every 30 min (risky)", minionType: "thief", emoji: "🦹" },
  { name: "Minion Farmer", price: 1500, type: "minion", description: "🌾 Hire a farmer — earns 8-20 coins every 30 min", minionType: "farmer", emoji: "🌾" },
  { name: "Minion Alchemist", price: 4000, type: "minion", description: "⚗️ Earns 15-40 coins every 30 min + random potion drops", minionType: "alchemist", emoji: "⚗️" },
  { name: "Minion Assassin", price: 5000, type: "minion", description: "🗡️ Steals 20-50 coins every 30 min (high risk, high reward)", minionType: "assassin", emoji: "🗡️" },
  { name: "Minion Slot", price: 500, type: "minion_slot", description: "Unlock one more minion slot (default: 1, max: 5)", emoji: "➕" },
  { name: "Minion Upgrade", price: 2000, type: "minion_upgrade", description: "Boost one minion's earnings by 50% permanently", emoji: "⬆️" },
];

// ─── Loan Interest Calculator ───────────────────────────────────────────────

export function calculateLoanTotal(amount, interestRate, hoursOverdue = 0) {
  const base = Math.ceil(amount * (1 + interestRate));
  if (hoursOverdue <= 0) return base;
  // 5% penalty per hour overdue, capped at 5x base (so max total is 6x base).
  // Prevents runaway numbers if a user ignores a loan for weeks.
  const penaltyMultiplier = Math.min(0.05 * hoursOverdue, 5);
  const penalty = Math.ceil(base * penaltyMultiplier);
  return base + penalty;
}

// ─── Mystery Box Outcomes ───────────────────────────────────────────────────

export function openMysteryBox() {
  const roll = Math.random();
  if (roll < 0.05) return { coins: 1000, label: "LEGENDARY — 1000 coins!" };
  if (roll < 0.15) return { coins: 500, label: "EPIC — 500 coins!" };
  if (roll < 0.30) return { coins: 200, label: "RARE — 200 coins" };
  if (roll < 0.55) return { coins: 100, label: "COMMON — 100 coins" };
  if (roll < 0.80) return { coins: 50, label: "meh — 50 coins" };
  if (roll < 0.95) return { coins: 10, label: "lol — 10 coins" };
  return { coins: 1, label: "CURSED — 1 coin 💀" };
}
