// ─── Game Visual Embeds & Button Builders ────────────────────────────────────
// Rich Discord embeds for all gambling, economy, and mini-game tools.
// Each function returns { embeds, components } ready for channel.send().

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/**
 * One frame of an animated embed sequence. `delay` overrides the default
 * per-frame timing; `components` attaches buttons (typically only on the final
 * result frame).
 * @typedef {{ embed: EmbedBuilder, delay?: number, components?: any[] }} AnimFrame
 */

const PURPLE = 0x9333EA;    // Eris's signature
const GOLD = 0xFFD700;      // Win / jackpot
const RED = 0xEF4444;       // Loss
const GREEN = 0x10B981;     // Success
const DARK = 0x2b2d31;      // Neutral / dark theme blend
const BLUE = 0x6366F1;      // Info / trivia

// ─── Card Emoji Helpers ─────────────────────────────────────────────────────

const SUIT_EMOJI = { "♠": "♠️", "♥": "♥️", "♦": "♦️", "♣": "♣️" };

function cardDisplay(card) {
  return `\`${card.rank}${SUIT_EMOJI[card.suit] || card.suit}\``;
}

function handDisplay(hand) {
  return hand.map(cardDisplay).join(" ");
}

// ─── Balance Card ───────────────────────────────────────────────────────────

export function balanceEmbed(username, econ) {
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`💰 ${username}'s Wallet`)
    .addFields(
      { name: "Balance", value: `**${econ.balance}** coins`, inline: true },
      { name: "Daily Streak", value: `🔥 ${econ.daily_streak || 0} days`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Total Earned", value: `📈 ${econ.total_earned || 0}`, inline: true },
      { name: "Total Lost", value: `📉 ${econ.total_lost || 0}`, inline: true },
      { name: "Total Gambled", value: `🎰 ${econ.total_gambled || 0}`, inline: true },
    )
    .setTimestamp();
}

// ─── Daily Reward ───────────────────────────────────────────────────────────

export function dailyEmbed(coins, streak, bonus, newBalance) {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("📦 Daily Reward Claimed!")
    .setDescription(`+**${coins}** coins`)
    .addFields(
      { name: "Streak", value: `🔥 ${streak} days`, inline: true },
      { name: "Bonus", value: `+${bonus}`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();
}

// ─── Coinflip ───────────────────────────────────────────────────────────────

export function coinflipEmbed(choice, result, won, amount, newBalance) {
  const embed = new EmbedBuilder()
    .setColor(won ? GOLD : RED)
    .setTitle(won ? "🪙 Coinflip — You Win!" : "🪙 Coinflip — You Lose!")
    .setDescription(`Flipped: **${result === "heads" ? "🪙 Heads" : "🏴 Tails"}**\nYou called: **${choice}**`)
    .addFields(
      { name: won ? "Won" : "Lost", value: `**${amount}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`flip_heads_${amount}`).setLabel(`Heads (${amount})`).setEmoji("🪙").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`flip_tails_${amount}`).setLabel(`Tails (${amount})`).setEmoji("🏴").setStyle(ButtonStyle.Secondary),
  );
  return { embed, row };
}

// ─── Dice Roll ──────────────────────────────────────────────────────────────

const DICE_EMOJI = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export function diceEmbed(guess, roll, won, amount, newBalance) {
  return new EmbedBuilder()
    .setColor(won ? GOLD : RED)
    .setTitle(won ? "🎲 Dice Roll — JACKPOT!" : "🎲 Dice Roll — Miss!")
    .setDescription(`${DICE_EMOJI[roll]} Rolled: **${roll}** — You guessed: **${guess}**`)
    .addFields(
      { name: won ? "Won (5x)" : "Lost", value: `**${won ? amount * 5 : amount}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();
}

// ─── Slots ──────────────────────────────────────────────────────────────────

export function slotsEmbed(reels, label, multiplier, amount, won, newBalance) {
  const display = reels.map(r => r.emoji).join("  ");
  const color = multiplier >= 10 ? GOLD : won ? GREEN : RED;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🎰 Slot Machine")
    .setDescription(`\n> ┃ ${display} ┃\n\n**${label}**`)
    .addFields(
      { name: multiplier > 1 ? `Won (${multiplier}x)` : "Lost", value: `**${multiplier > 1 ? amount * multiplier : amount}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`slots_${amount}`).setLabel(`Spin Again (${amount})`).setEmoji("🎰").setStyle(ButtonStyle.Primary),
  );
  return { embed, row };
}

// ─── Blackjack ──────────────────────────────────────────────────────────────

export function blackjackDealEmbed(playerHand, dealerHand, playerValue, stake) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🃏 Blackjack")
    .addFields(
      { name: "Your Hand", value: `${handDisplay(playerHand)}\nValue: **${playerValue}**`, inline: true },
      { name: "Dealer", value: `${cardDisplay(dealerHand[0])} \`??\`\nShowing: **${dealerHand[0].rank === "A" ? 11 : ["K","Q","J"].includes(dealerHand[0].rank) ? 10 : parseInt(dealerHand[0].rank)}**`, inline: true },
    )
    .setFooter({ text: `Bet: ${stake} coins` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bj_hit").setLabel("Hit").setEmoji("👊").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bj_stand").setLabel("Stand").setEmoji("🛑").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bj_double").setLabel("Double Down").setEmoji("💰").setStyle(ButtonStyle.Danger),
  );

  return { embed, row };
}

export function blackjackHitEmbed(playerHand, dealerHand, playerValue, stake) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🃏 Blackjack")
    .addFields(
      { name: "Your Hand", value: `${handDisplay(playerHand)}\nValue: **${playerValue}**`, inline: true },
      { name: "Dealer", value: `${cardDisplay(dealerHand[0])} \`??\``, inline: true },
    )
    .setFooter({ text: `Bet: ${stake} coins` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bj_hit").setLabel("Hit").setEmoji("👊").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bj_stand").setLabel("Stand").setEmoji("🛑").setStyle(ButtonStyle.Secondary),
  );

  return { embed, row };
}

export function blackjackResultEmbed(playerHand, dealerHand, playerValue, dealerValue, resultText, payout, stake, newBalance, isNatural = false) {
  const won = payout > 0;
  const tie = payout === 0;
  return new EmbedBuilder()
    .setColor(isNatural ? GOLD : won ? GREEN : tie ? DARK : RED)
    .setTitle(isNatural ? "🃏 BLACKJACK!" : `🃏 Blackjack — ${resultText}`)
    .addFields(
      { name: "Your Hand", value: `${handDisplay(playerHand)}\nValue: **${playerValue}**`, inline: true },
      { name: "Dealer", value: `${handDisplay(dealerHand)}\nValue: **${dealerValue}**`, inline: true },
      { name: "\u200b", value: "\u200b", inline: false },
      { name: payout > 0 ? "Won" : payout < 0 ? "Lost" : "Push", value: `**${Math.abs(payout)}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();
}

// ─── Russian Roulette ───────────────────────────────────────────────────────

export function rouletteEmbed(survived, stake, winnings, newBalance) {
  const embed = survived
    ? new EmbedBuilder()
      .setColor(GREEN)
      .setTitle("🔫 Russian Roulette — *click* ... Survived!")
      .setDescription("the chamber was empty... you live to gamble another day 😮‍💨")
      .addFields(
        { name: "Won", value: `**${winnings}** coins`, inline: true },
        { name: "Balance", value: `💰 ${newBalance}`, inline: true },
      )
      .setTimestamp()
    : new EmbedBuilder()
      .setColor(RED)
      .setTitle("🔫 Russian Roulette — *click* **BANG!** 💀")
      .setDescription("rest in pieces")
      .addFields(
        { name: "Lost", value: `**${stake}** coins`, inline: true },
        { name: "Balance", value: `💰 ${newBalance}`, inline: true },
      )
      .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roulette_${stake}`).setLabel(`Pull Trigger Again (${stake})`).setEmoji("🔫").setStyle(ButtonStyle.Danger),
  );
  return { embed, row };
}

// ─── RPS ────────────────────────────────────────────────────────────────────

const RPS_EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };

export function rpsEmbed(playerChoice, botChoice, result, won, stake, newBalance) {
  const color = won === true ? GREEN : won === false ? RED : DARK;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle("Rock Paper Scissors")
    .setDescription(`${RPS_EMOJI[playerChoice]}  **vs**  ${RPS_EMOJI[botChoice]}\n\n**${result === "tie" ? "It's a tie!" : result === "you win" ? "You win!" : "You lose!"}**`)
    .addFields(
      stake > 0 && won !== null
        ? [
          { name: won ? "Won" : "Lost", value: `**${stake}** coins`, inline: true },
          { name: "Balance", value: `💰 ${newBalance}`, inline: true },
        ]
        : [],
    )
    .setTimestamp();
}

// ─── Trivia ─────────────────────────────────────────────────────────────────

export function triviaQuestionEmbed(question, answers, difficulty, stake) {
  const labels = ["🅰️", "🅱️", "🅲", "🅳"];
  const answerText = answers.map((a, i) => `${labels[i]}  ${a}`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle("🧠 Trivia")
    .setDescription(`**${question}**\n\n${answerText}`)
    .setFooter({ text: `Difficulty: ${difficulty}${stake > 0 ? ` • Stake: ${stake} coins` : ""}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("trivia_A").setLabel("A").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("trivia_B").setLabel("B").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("trivia_C").setLabel("C").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("trivia_D").setLabel("D").setStyle(ButtonStyle.Primary),
  );

  return { embed, row };
}

export function triviaResultEmbed(correct, question, correctAnswer, userAnswer, stats, payout) {
  return new EmbedBuilder()
    .setColor(correct ? GREEN : RED)
    .setTitle(correct ? "🧠 Correct! ✅" : "🧠 Wrong! ❌")
    .setDescription(`The answer was: **${correctAnswer}**`)
    .addFields(
      { name: "Streak", value: `🔥 ${stats.current_streak}`, inline: true },
      { name: "Record", value: `${stats.correct}/${stats.correct + stats.wrong}`, inline: true },
      payout !== 0 ? { name: payout > 0 ? "Won" : "Lost", value: `**${Math.abs(payout)}** coins`, inline: true } : { name: "\u200b", value: "\u200b", inline: true },
    )
    .setTimestamp();
}

// ─── Word Scramble ──────────────────────────────────────────────────────────

export function wordScrambleEmbed(scrambled, length, stake) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle("🔤 Word Scramble")
    .setDescription(`Unscramble this word:\n\n> **${scrambled.split("").join(" ")}**\n\n${length} letters • 5 attempts`)
    .setFooter({ text: stake > 0 ? `Stake: ${stake} coins` : "Type your guess!" })
    .setTimestamp();
}

export function wordScrambleHintEmbed(scrambled, hint, attemptsLeft) {
  return new EmbedBuilder()
    .setColor(DARK)
    .setTitle("🔤 Word Scramble — Wrong!")
    .setDescription(`> **${scrambled.split("").join(" ")}**\n\nHint: starts with **${hint}**\n${attemptsLeft} attempts left`)
    .setTimestamp();
}

export function wordScrambleResultEmbed(won, word, attempts, stake) {
  return new EmbedBuilder()
    .setColor(won ? GREEN : RED)
    .setTitle(won ? "🔤 Word Scramble — Solved! ✅" : "🔤 Word Scramble — Out of Attempts!")
    .setDescription(`The word was: **${word}**${won ? `\nSolved in ${attempts} attempt${attempts !== 1 ? "s" : ""}` : ""}`)
    .addFields(
      stake > 0 ? [{ name: won ? "Won" : "Lost", value: `**${stake}** coins`, inline: true }] : [],
    )
    .setTimestamp();
}

// ─── Number Guess ───────────────────────────────────────────────────────────

export function numberGuessStartEmbed(max, stake) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle("🔢 Number Guessing Game")
    .setDescription(`i'm thinking of a number between **1** and **${max}**\n\nyou have **7** guesses`)
    .setFooter({ text: stake > 0 ? `Stake: ${stake} coins` : "Type a number!" })
    .setTimestamp();
}

export function numberGuessHintEmbed(hint, attemptsLeft, max) {
  return new EmbedBuilder()
    .setColor(DARK)
    .setTitle(`🔢 ${hint === "higher" ? "⬆️ Higher!" : "⬇️ Lower!"}`)
    .setDescription(`${attemptsLeft} guesses left`)
    .setTimestamp();
}

export function numberGuessResultEmbed(won, secret, attempts, stake) {
  return new EmbedBuilder()
    .setColor(won ? GREEN : RED)
    .setTitle(won ? "🔢 Correct! 🎉" : "🔢 Out of Guesses!")
    .setDescription(`The number was: **${secret}**${won ? `\nGot it in ${attempts} guess${attempts !== 1 ? "es" : ""}!` : ""}`)
    .addFields(
      stake > 0 ? [{ name: won ? "Won" : "Lost", value: `**${stake}** coins`, inline: true }] : [],
    )
    .setTimestamp();
}

// ─── Fortune ────────────────────────────────────────────────────────────────

export function fortuneEmbed(fortune, question) {
  return new EmbedBuilder()
    .setColor(0x8B5CF6)
    .setTitle("🔮 Eris's Fortune")
    .setDescription(question ? `> *"${question}"*\n\n${fortune}` : fortune)
    .setTimestamp();
}

// ─── Duel ───────────────────────────────────────────────────────────────────

export function duelChallengeEmbed(challengerName, targetName, targetId, stake) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("⚔️ Duel Challenge!")
    .setDescription(`**${challengerName}** challenges **${targetName}** to a duel!${stake > 0 ? `\n\nStake: **${stake}** coins each` : ""}`)
    .setFooter({ text: "Expires in 5 minutes" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_accept_${targetId}`).setLabel("Accept Duel").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
  );

  return { embed, row };
}

export function duelResultEmbed(winnerName, loserName, stake) {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("⚔️ Duel Resolved!")
    .setDescription(`**${winnerName}** defeats **${loserName}**!${stake > 0 ? `\n\n💰 **${stake}** coins claimed!` : ""}`)
    .setTimestamp();
}

// ─── Leaderboard ────────────────────────────────────────────────────────────

export function leaderboardEmbed(entries) {
  const medals = ["👑", "🥈", "🥉"];
  const lines = entries.map((e, i) => `${medals[i] || `\`${i + 1}.\``} <@${e.user_id}> — **${e.balance}** coins`);
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("💰 Richest Users")
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

// ─── Rob ────────────────────────────────────────────────────────────────────

export function robEmbed(success, robberName, targetName, amount, newBalance) {
  if (success) {
    return new EmbedBuilder()
      .setColor(GREEN)
      .setTitle("🦹 Heist Successful!")
      .setDescription(`**${robberName}** stole **${amount}** coins from **${targetName}**!`)
      .addFields({ name: "Balance", value: `💰 ${newBalance}`, inline: true })
      .setTimestamp();
  }
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle("🚨 Heist Failed!")
    .setDescription(`**${robberName}** got caught trying to rob **${targetName}**!`)
    .addFields(
      { name: "Fine", value: `**${amount}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();
}

// ─── Curse ───────────────────────────────────────────────────────────────────

export function curseEmbed(targetName, curseName) {
  return new EmbedBuilder()
    .setColor(0x8B0000)
    .setTitle("💀 CURSED!")
    .setDescription(`**${targetName}** is now **"${curseName}"** for 10 minutes`)
    .setTimestamp();
}

// ─── Confession ─────────────────────────────────────────────────────────────

export function confessionEmbed(number, text) {
  return new EmbedBuilder()
    .setColor(DARK)
    .setTitle(`📢 Confession #${number}`)
    .setDescription(text)
    .setFooter({ text: "submitted anonymously" })
    .setTimestamp();
}

// ─── Shop ───────────────────────────────────────────────────────────────────

export function shopEmbed(items) {
  const lines = items.map(i => `**${i.name}** — ${i.price} coins\n> ${i.description || "no description"}${i.limited_stock !== null ? ` (${i.limited_stock} left)` : ""}`);
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🛒 Eris's Shop")
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: "use shop_buy to purchase" })
    .setTimestamp();
}

export function shopBuyEmbed(item, newBalance) {
  return new EmbedBuilder()
    .setColor(GREEN)
    .setTitle("🛒 Purchase Complete!")
    .setDescription(`Bought **${item.name}** for **${item.price}** coins`)
    .addFields({ name: "Balance", value: `💰 ${newBalance}`, inline: true })
    .setTimestamp();
}

export function inventoryEmbed(username, items) {
  const grouped = {};
  for (const i of items) {
    if (!grouped[i.item_type]) grouped[i.item_type] = [];
    grouped[i.item_type].push(i.item_name);
  }
  const fields = Object.entries(grouped).map(([type, names]) => ({
    name: type.charAt(0).toUpperCase() + type.slice(1),
    value: names.join(", "),
    inline: true,
  }));
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`🎒 ${username}'s Inventory`)
    .addFields(fields.length ? fields : [{ name: "Empty", value: "nothing here yet" }])
    .setTimestamp();
}

// ─── Loan ───────────────────────────────────────────────────────────────────

export function loanEmbed(amount, totalOwed, hoursLeft) {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle("🦈 Loan Approved")
    .setDescription(`You borrowed **${amount}** coins`)
    .addFields(
      { name: "Total Owed", value: `**${totalOwed}** coins (20% interest)`, inline: true },
      { name: "Due In", value: `${hoursLeft} hours`, inline: true },
    )
    .setFooter({ text: "pay back on time or face penalties..." })
    .setTimestamp();
}

// ─── Bounty ─────────────────────────────────────────────────────────────────

export function bountyEmbed(targetName, amount, placedBy) {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle("🎯 Bounty Posted!")
    .setDescription(`**${amount}** coins on **${targetName}**'s head`)
    .addFields({ name: "Placed By", value: placedBy, inline: true })
    .setFooter({ text: "beat them in a duel to collect" })
    .setTimestamp();
}

export function bountyBoardEmbed(bounties, guild) {
  const lines = bounties.map((b, i) => {
    const target = guild?.members.cache.get(b.target_user_id)?.displayName || `User ${b.target_user_id}`;
    return `${i + 1}. **${target}** — **${b.amount}** coins`;
  });
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle("🎯 Bounty Board")
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

// ─── Daily Challenge ────────────────────────────────────────────────────────

// Challenge type → human readable description
const CHALLENGE_DESCS = {
  coinflip_wins: "Win {t} coinflip(s)",
  dice_wins: "Win {t} dice roll(s)",
  slots_play: "Spin the slots {t} time(s)",
  rps_wins: "Win {t} RPS game(s)",
  trivia_correct: "Answer {t} trivia question(s) correctly",
  total_wagered: "Wager a total of {t} coins",
  rob_attempt: "Attempt {t} robbery(ies)",
  duel_wins: "Win {t} duel(s)",
  earn_coins: "Earn {t} coins total today",
  survive_roulette: "Survive russian roulette {t} time(s)",
};

export function dailyChallengeEmbed(challenge, completed) {
  const template = CHALLENGE_DESCS[challenge.challenge_type] || challenge.challenge_type;
  const desc = challenge.description || template.replace("{t}", challenge.challenge_target);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("challenge_complete").setLabel("Claim Reward").setEmoji("🎁").setStyle(completed ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(completed),
  );

  return {
    embed: new EmbedBuilder()
      .setColor(completed ? GREEN : BLUE)
      .setTitle(completed ? "✅ Daily Challenge — Completed!" : "📋 Daily Challenge")
      .setDescription(desc)
      .addFields(
        { name: "Reward", value: `**${challenge.reward}** coins`, inline: true },
        { name: "Status", value: completed ? "✅ Done" : "⏳ In Progress", inline: true },
      )
      .setTimestamp(),
    row: completed ? null : row,
  };
}

// ─── Achievements ───────────────────────────────────────────────────────────

// ─── Stocks ─────────────────────────────────────────────────────────────────

export function stockListEmbed(stocks) {
  const lines = stocks.map(s => `**${s.symbol}** (${s.name}) — $${s.price.toFixed(2)} ${s.volatility > 0.1 ? "🔥" : ""}`);
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle("📈 Stock Market")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "prices update every 5 minutes" })
    .setTimestamp();
}

export function stockBuyEmbed(symbol, shares, price, totalCost, newBalance) {
  return new EmbedBuilder()
    .setColor(GREEN)
    .setTitle("📈 Stock Purchased")
    .setDescription(`Bought **${shares}** shares of **${symbol}** at $${price.toFixed(2)} each`)
    .addFields(
      { name: "Total Cost", value: `${totalCost} coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    )
    .setTimestamp();
}

export function stockSellEmbed(symbol, shares, price, revenue, profit) {
  return new EmbedBuilder()
    .setColor(profit >= 0 ? GREEN : RED)
    .setTitle("📉 Stock Sold")
    .setDescription(`Sold **${shares}** shares of **${symbol}** at $${price.toFixed(2)} each`)
    .addFields(
      { name: "Revenue", value: `${revenue} coins`, inline: true },
      { name: "P/L", value: `${profit >= 0 ? "+" : ""}${profit} coins`, inline: true },
    )
    .setTimestamp();
}

export function portfolioEmbed(username, holdings) {
  const totalValue = holdings.reduce((s, h) => s + h.totalValue, 0);
  const totalProfit = holdings.reduce((s, h) => s + h.profit, 0);
  const lines = holdings.map(h => `**${h.stock_symbol}** — ${h.shares} shares @ $${h.currentPrice.toFixed(2)} = ${h.totalValue} coins (${h.profit >= 0 ? "+" : ""}${h.profit})`);
  return new EmbedBuilder()
    .setColor(totalProfit >= 0 ? GREEN : RED)
    .setTitle(`📊 ${username}'s Portfolio`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Total Value", value: `${totalValue} coins`, inline: true },
      { name: "Total P/L", value: `${totalProfit >= 0 ? "+" : ""}${totalProfit} coins`, inline: true },
    )
    .setTimestamp();
}

export function achievementsEmbed(allAchievements, unlockedKeys, username) {
  const lines = Object.entries(allAchievements).map(([key, a]) => {
    const unlocked = unlockedKeys.has(key);
    return `${unlocked ? a.icon : "🔒"} **${a.name}** — ${a.desc}${unlocked ? " ✅" : ""}`;
  });
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`🏆 ${username}'s Achievements`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `${unlockedKeys.size}/${Object.keys(allAchievements).length} unlocked` })
    .setTimestamp();
}

// ─── Animation Helper ──────────────────────────────────────────────────────
// Supports per-frame delay via frame.delay property, falls back to delayMs

/**
 * @param {import("discord.js").SendableChannels} channel
 * @param {AnimFrame[]} frames
 * @param {number} [delayMs]
 */
export async function animateEmbed(channel, frames, delayMs = 800) {
  const msg = await channel.send({ embeds: [frames[0].embed], components: frames[0].components || [] });
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, frames[i].delay || delayMs));
    await msg.edit({ embeds: [frames[i].embed], components: frames[i].components || [] }).catch(() => {});
  }
  return msg;
}

// Edit-in-place variant — updates an existing message/interaction instead of sending new
export async function animateEmbedEdit(target, frames, delayMs = 800) {
  const isInteraction = typeof target.update === "function";
  if (isInteraction) {
    await target.update({ embeds: [frames[0].embed], components: frames[0].components || [] });
  } else {
    await target.edit({ embeds: [frames[0].embed], components: frames[0].components || [] }).catch(() => {});
  }
  const msg = isInteraction ? await target.fetchReply().catch(() => null) : target;
  if (!msg) return;
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, frames[i].delay || delayMs));
    await msg.edit({ embeds: [frames[i].embed], components: frames[i].components || [] }).catch(() => {});
  }
  return msg;
}

// ─── Animated Dice with Buttons ────────────────────────────────────────────

export function diceButtonsEmbed(amount) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🎲 Dice Roll")
    .setDescription(`Bet: **${amount}** coins\nPick a number (1-6). Roll it = **5x payout!**`);
  const row = new ActionRowBuilder().addComponents(
    ...[1,2,3,4,5,6].map(n => new ButtonBuilder().setCustomId(`dice_${n}_${amount}`).setLabel(`${n}`).setEmoji(["","⚀","⚁","⚂","⚃","⚄","⚅"][n]).setStyle(ButtonStyle.Secondary))
  );
  return { embed, row };
}

/** @returns {AnimFrame[]} */
export function diceAnimFrames(roll) {
  const DICE = ["","⚀","⚁","⚂","⚃","⚄","⚅"];
  const rand = () => Math.floor(Math.random() * 6) + 1;
  const wave = ["▁▂▃▄▅▆▇█", "▃▅▇█▇▅▃▁", "▇█▇▅▃▁▂▃", "▅▃▁▂▃▅▇█"];
  return [
    // Fast spin — all random
    { embed: new EmbedBuilder().setColor(DARK).setTitle("🎲 Rolling...").setDescription(`\`${wave[0]}\`\n\n> ${DICE[rand()]}  ${DICE[rand()]}  ${DICE[rand()]}\n\n\`${wave[0]}\``), delay: 500 },
    // Slower — still random
    { embed: new EmbedBuilder().setColor(DARK).setTitle("🎲 Rolling...").setDescription(`\`${wave[1]}\`\n\n> ${DICE[rand()]}  ${DICE[rand()]}  ${DICE[rand()]}\n\n\`${wave[1]}\``), delay: 500 },
    // Slowing down — center locks
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle("🎲 Rolling...").setDescription(`\`${wave[2]}\`\n\n> ${DICE[rand()]}  **${DICE[roll]}**  ${DICE[rand()]}\n\n\`${wave[2]}\``), delay: 600 },
    // Almost stopped
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle("🎲 Rolling...").setDescription(`\`${wave[3]}\`\n\n> ⠀  **${DICE[roll]}**  ⠀\n\n\`${wave[3]}\``), delay: 700 },
    // Final — clean result
    { embed: new EmbedBuilder().setColor(DARK).setTitle("🎲 Rolled!").setDescription(`\n> **${DICE[roll]}**\n`) },
  ];
}

// ─── RPS with Buttons ──────────────────────────────────────────────────────

export function rpsButtonsEmbed(amount) {
  const desc = amount > 0 ? `Bet: **${amount}** coins` : "Just for fun!";
  const embed = new EmbedBuilder().setColor(PURPLE).setTitle("✊ Rock Paper Scissors").setDescription(desc);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps_rock_${amount}`).setLabel("Rock").setEmoji("🪨").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_paper_${amount}`).setLabel("Paper").setEmoji("📄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_scissors_${amount}`).setLabel("Scissors").setEmoji("✂️").setStyle(ButtonStyle.Primary),
  );
  return { embed, row };
}

export function rpsResultEmbed(playerChoice, botChoice, result, amount, newBalance) {
  const emojis = { rock: "🪨", paper: "📄", scissors: "✂️" };
  const color = result === "win" ? GOLD : result === "lose" ? RED : DARK;
  const title = result === "win" ? "You Win!" : result === "lose" ? "You Lose!" : "It's a Tie!";
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`✊ Rock Paper Scissors — ${title}`)
    .setDescription(`${emojis[playerChoice]} vs ${emojis[botChoice]}`)
    .addFields(
      { name: result === "win" ? "Won" : result === "lose" ? "Lost" : "Tied", value: result === "tie" ? "0 coins" : `**${amount}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    ).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps_rock_${amount}`).setLabel("Rock").setEmoji("🪨").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_paper_${amount}`).setLabel("Paper").setEmoji("📄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_scissors_${amount}`).setLabel("Scissors").setEmoji("✂️").setStyle(ButtonStyle.Primary),
  );
  return { embed, row };
}

// ─── Animated Slots Frames ─────────────────────────────────────────────────

/** @returns {AnimFrame[]} */
export function slotsAnimFrames(finalReels) {
  const SLOT_SYMBOLS = ["🍒","🍋","🍊","🔔","💎","7️⃣","💀"];
  const r = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const border = "━━━━━━━━━━━━";
  return [
    // All spinning — fast
    { embed: new EmbedBuilder().setColor(DARK).setTitle("🎰 Spinning...").setDescription(`${border}\n\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n\n${border}`), delay: 500 },
    // Still spinning — different randoms
    { embed: new EmbedBuilder().setColor(DARK).setTitle("🎰 Spinning...").setDescription(`${border}\n\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n\n${border}`), delay: 500 },
    // Reel 1 LOCKS — flash
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle("🎰 Spinning...").setDescription(`${border}\n\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n┃ **${finalReels[0].emoji}** ┃  ${r()}  ┃  ${r()} ┃  🔒\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n\n${border}`), delay: 600 },
    // Reel 2 LOCKS
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle("🎰 Spinning...").setDescription(`${border}\n\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n┃ **${finalReels[0].emoji}** ┃  **${finalReels[1].emoji}** ┃  ${r()} ┃  🔒🔒\n┃ ${r()}  ┃  ${r()}  ┃  ${r()} ┃\n\n${border}`), delay: 700 },
    // Reel 3 slowing — suspense
    { embed: new EmbedBuilder().setColor(DARK).setTitle("🎰 Stopping...").setDescription(`${border}\n\n┃ ⠀  ┃  ⠀  ┃  ${r()} ┃\n┃ **${finalReels[0].emoji}** ┃  **${finalReels[1].emoji}** ┃  ${r()} ┃  🔒🔒\n┃ ⠀  ┃  ⠀  ┃  ${r()} ┃\n\n${border}`), delay: 800 },
  ];
}

// ─── Lootbox Animated Opening ──────────────────────────────────────────────

export function lootboxAnimFrames() {
  const particles = ["✦", "✧", "⊹", "˚", "⟡"];
  const r = () => particles[Math.floor(Math.random() * particles.length)];
  return [
    // Box appears
    { embed: new EmbedBuilder().setColor(DARK).setTitle("📦 Loot Box").setDescription("━━━━━━━━━━━━\n\n⠀⠀⠀⠀📦\n\n━━━━━━━━━━━━"), delay: 800 },
    // Shaking left
    { embed: new EmbedBuilder().setColor(DARK).setTitle("📦 Loot Box").setDescription("━━━━━━━━━━━━\n\n⠀⠀⠀📦⠀\n\n━━━━━━━━━━━━"), delay: 400 },
    // Shaking right
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle("📦✨ Loot Box").setDescription(`━━━━━━━━━━━━\n\n⠀⠀⠀⠀⠀📦  ${r()}\n\n━━━━━━━━━━━━`), delay: 400 },
    // Shaking harder
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle("📦✨ Loot Box").setDescription(`━━━━━━━━━━━━\n\n${r()} ⠀⠀📦⠀ ${r()}\n${r()} ⠀⠀⠀⠀⠀ ${r()}\n\n━━━━━━━━━━━━`), delay: 400 },
    // Cracking open — particles flying
    { embed: new EmbedBuilder().setColor(GOLD).setTitle("🎁💫 Loot Box").setDescription(`━━━━━━━━━━━━\n\n${r()} ${r()} ⠀🎁⠀ ${r()} ${r()}\n${r()} ⠀${r()} ⠀${r()} ⠀${r()}\n⠀${r()} ⠀⠀⠀ ${r()}\n\n━━━━━━━━━━━━`), delay: 500 },
    // Flash white
    { embed: new EmbedBuilder().setColor(0xffffff).setTitle("✨").setDescription("█".repeat(16)), delay: 300 },
  ];
}

export function lootboxResultEmbed(item, coins, newBalance) {
  const color = coins >= 200 ? GOLD : coins >= 50 ? GREEN : DARK;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🎁 Loot Box — Opened!")
    .setDescription(item ? `You found: **${item}**!` : `You found **${coins}** coins!`)
    .addFields({ name: "Balance", value: `💰 ${newBalance}`, inline: true })
    .setTimestamp();
  return embed;
}

// ─── Scratch Card ──────────────────────────────────────────────────────────

export function scratchCardEmbed(grid, revealed, tier, results) {
  const display = grid.map((row, r) => row.map((sym, c) => revealed[r][c] ? sym : "❓").join(" ")).join("\n");
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`🎫 Scratch Card (${tier} coins)`)
    .setDescription(`\n${display}\n\n${results || "Tap the buttons to reveal!"}`);

  // Create buttons for unrevealed cells (max 2 rows of 3 = 6 buttons, Discord limit is 5 per row)
  const rows = [];
  let btnCount = 0;
  for (let r = 0; r < 3; r++) {
    const actionRow = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      if (btnCount >= 9) break;
      const id = `scratch_${r}_${c}`;
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(id)
          .setLabel(revealed[r][c] ? grid[r][c] : "❓")
          .setStyle(revealed[r][c] ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(revealed[r][c])
      );
      btnCount++;
    }
    rows.push(actionRow);
  }
  return { embed, rows };
}

// ─── Grinding Activity Embeds ──────────────────────────────────────────────

const RARITY_COLORS = { mythic: GOLD, legendary: PURPLE, epic: BLUE, rare: GREEN, uncommon: 0x3B82F6, common: DARK, junk: 0x6B7280 };

export function activityEmbed(activity, item, coins, rarity, newBalance, emoji) {
  const color = RARITY_COLORS[rarity] || DARK;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${activity}`)
    .setDescription(`${item}\n+**${coins}** coins`)
    .addFields({ name: "Balance", value: `💰 ${newBalance}`, inline: true })
    .setFooter({ text: rarity ? rarity.toUpperCase() : "" })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`again_${activity.toLowerCase().replace(/\s/g, "_")}`).setLabel(`${activity} Again`).setEmoji(emoji).setStyle(ButtonStyle.Primary),
  );
  return { embed, row };
}

export function activityAnimFrames(activity, emoji) {
  const dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
  const waves = ["▁▂▃▄▅▆", "▃▅▇█▇▅", "▆▇█▇▅▃", "▇▅▃▁▂▃"];
  const verbs = {
    "Fish": ["Casting line...", "Waiting for a bite...", "Something's tugging..."],
    "Hunt": ["Tracking prey...", "Following tracks...", "Target spotted..."],
    "Dig": ["Digging...", "Going deeper...", "Found something..."],
    "Work": ["Clocking in...", "Working hard...", "Finishing up..."],
    "Beg": ["Looking pathetic...", "Holding out cup...", "Someone noticed..."],
    "Search": ["Searching...", "Looking around...", "Checking under things..."],
  };
  const steps = verbs[activity] || ["Working...", "Still going...", "Almost done..."];
  return [
    { embed: new EmbedBuilder().setColor(DARK).setTitle(`${emoji} ${steps[0]}`).setDescription(`\`${waves[0]}\`\n\n${dots[0]}`), delay: 700 },
    { embed: new EmbedBuilder().setColor(DARK).setTitle(`${emoji} ${steps[1]}`).setDescription(`\`${waves[1]}\`\n\n${dots[3]}`), delay: 700 },
    { embed: new EmbedBuilder().setColor(PURPLE).setTitle(`${emoji} ${steps[2]}`).setDescription(`\`${waves[2]}\`\n\n${dots[6]}`), delay: 700 },
  ];
}

// Legacy single-frame compat
export function activityAnimFrame(activity, emoji) {
  return activityAnimFrames(activity, emoji)[0];
}

// ─── Adventure Choice Buttons ──────────────────────────────────────────────

export function adventureSceneEmbed(title, description, choices, sceneNum) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`🗺️ Adventure — ${title}`)
    .setDescription(description)
    .setFooter({ text: `Scene ${sceneNum}` });
  const row = new ActionRowBuilder().addComponents(
    ...choices.map((choice, i) =>
      new ButtonBuilder().setCustomId(`adventure_${i}`).setLabel(choice).setStyle(ButtonStyle.Primary)
    )
  );
  return { embed, row };
}

export function adventureResultEmbed(title, outcome, coins, newBalance) {
  const color = coins > 0 ? GOLD : coins < 0 ? RED : DARK;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🗺️ Adventure — ${title}`)
    .setDescription(outcome)
    .addFields(
      { name: coins >= 0 ? "Earned" : "Lost", value: `**${Math.abs(coins)}** coins`, inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    ).setTimestamp();
  return embed;
}

// ─── Pet Battle Animated Embeds ────────────────────────────────────────────

function hpBar(current, max) {
  const filled = Math.round((current / max) * 10);
  return "🟩".repeat(Math.max(0, filled)) + "⬛".repeat(10 - Math.max(0, filled));
}

export function petBattleRoundEmbed(pet1, pet2, hp1, hp2, maxHp1, maxHp2, round, attackLog) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`⚔️ Pet Battle — Round ${round}`)
    .addFields(
      { name: pet1.name, value: `${hpBar(hp1, maxHp1)} ${hp1}/${maxHp1} HP`, inline: true },
      { name: "VS", value: "⚔️", inline: true },
      { name: pet2.name, value: `${hpBar(hp2, maxHp2)} ${hp2}/${maxHp2} HP`, inline: true },
    );
  if (attackLog) embed.setDescription(attackLog);
  return embed;
}

export function petBattleResultEmbed(winner, loser, coins) {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("⚔️ Pet Battle — Victory!")
    .setDescription(`**${winner}** wins! Earned **${coins}** coins`)
    .setTimestamp();
}

// ─── Boss Fight Embed ──────────────────────────────────────────────────────

export function bossEmbed(bossName, bossEmoji, currentHp, maxHp, attackerName, damage) {
  const bar = hpBar(currentHp, maxHp);
  const embed = new EmbedBuilder()
    .setColor(currentHp > 0 ? RED : GOLD)
    .setTitle(`${bossEmoji} ${bossName}`)
    .setDescription(`${bar} **${currentHp}/${maxHp}** HP${damage ? `\n\n${attackerName} dealt **${damage}** damage!` : ""}`)
    .setTimestamp();
  const row = currentHp > 0 ? new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("boss_attack").setLabel("Attack (10 coins)").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
  ) : null;
  return { embed, row };
}

// ─── Duel Animated Countdown ───────────────────────────────────────────────

/** @returns {AnimFrame[]} */
export function duelCountdownFrames(challenger, target) {
  const vs = `**${challenger}** ⠀vs⠀ **${target}**`;
  return [
    // Setup
    { embed: new EmbedBuilder().setColor(DARK).setTitle("⚔️ DUEL").setDescription(`${vs}\n\n── ⊹ ──\n\n⠀⠀⠀⠀preparing...\n\n── ⊹ ──`), delay: 800 },
    // 3 — calm
    { embed: new EmbedBuilder().setColor(RED).setTitle("⚔️ DUEL").setDescription(`${vs}\n\n━━━━━━━━━━━━\n\n# 3\n\n━━━━━━━━━━━━`), delay: 500 },
    // 3 — pulse
    { embed: new EmbedBuilder().setColor(DARK).setTitle("⚔️ DUEL").setDescription(`${vs}\n\n── ✦ ──\n\n# **3**\n\n── ✦ ──`), delay: 500 },
    // 2 — calm
    { embed: new EmbedBuilder().setColor(RED).setTitle("⚔️ DUEL").setDescription(`${vs}\n\n━━━━━━━━━━━━\n\n# 2\n\n━━━━━━━━━━━━`), delay: 500 },
    // 2 — pulse
    { embed: new EmbedBuilder().setColor(DARK).setTitle("⚔️ DUEL").setDescription(`${vs}\n\n── ⟡ ──\n\n# **2**\n\n── ⟡ ──`), delay: 500 },
    // 1 — tense
    { embed: new EmbedBuilder().setColor(RED).setTitle("⚔️ DUEL").setDescription(`${vs}\n\n━━━━━━━━━━━━\n\n# 1\n\n━━━━━━━━━━━━`), delay: 500 },
    // 1 — flash
    { embed: new EmbedBuilder().setColor(0xffffff).setTitle("⚔️").setDescription("━━━━━━━━━━━━━━━━━━"), delay: 300 },
    // FIGHT!
    { embed: new EmbedBuilder().setColor(GOLD).setTitle("⚔️ FIGHT!").setDescription(`━━━━━━━━━━━━\n\n# ✨ FIGHT! ✨\n\n${vs}\n\n━━━━━━━━━━━━`), delay: 800 },
  ];
}

export function duelResultEmbedAnimated(winnerName, loserName, stake, newBalance) {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`⚔️ ${winnerName} Wins!`)
    .setDescription(`${winnerName} defeated ${loserName}!`)
    .addFields(
      { name: stake > 0 ? "Won" : "Result", value: stake > 0 ? `**${stake}** coins` : "Bragging rights", inline: true },
      { name: "Balance", value: `💰 ${newBalance}`, inline: true },
    ).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_rematch_${loserName}`).setLabel("Rematch?").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
  );
  return { embed, row };
}

// ─── Heist Join Button ─────────────────────────────────────────────────────

export function heistLobbyEmbed(organizerName, participants, target) {
  const embed = new EmbedBuilder()
    .setColor(DARK)
    .setTitle("🏦 Heist — Recruiting")
    .setDescription(`**${organizerName}** is planning a heist!\n\nParticipants (${participants.length}/3 min):\n${participants.map(p => `• ${p}`).join("\n") || "None yet"}`)
    .setFooter({ text: "Need 3+ people to execute" });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("heist_join").setLabel("Join Heist").setEmoji("🏦").setStyle(ButtonStyle.Primary),
    ...(participants.length >= 3 ? [new ButtonBuilder().setCustomId("heist_execute").setLabel("Execute!").setEmoji("💥").setStyle(ButtonStyle.Danger)] : []),
  );
  return { embed, row };
}
