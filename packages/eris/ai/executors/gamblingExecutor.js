// ─── Gambling Sub-Executor ───────────────────────────────────────────────────
// Handles: coinflip_bet, dice_roll_bet, slots_spin, blackjack_start,
//          blackjack_action, rob_user, russian_roulette, rps_play
// Called from main executor.js via delegation.

import * as db from "../../database.js";
import { resolveMember } from "../../utils/discord.js";
import { log } from "../../utils/logger.js";

const HANDLED = new Set([
  "coinflip_bet", "dice_roll_bet", "slots_spin", "blackjack_start",
  "blackjack_action", "rob_user", "russian_roulette", "rps_play",
]);

// Hard cap prevents integer overflow, precision loss, and economy nukes from
// hallucinated Gemini numbers. Anything above 1M should use a different system.
const MAX_BET = 1_000_000;

// Per-game serialization — prevents parallel blackjack_action calls from both
// reading the same game state, each pushing deck.pop() / saving their mutation,
// and silently corrupting the hand. Same pattern as withEconLock in database.js.
const _gameLocks = new Map();
async function withGameLock(key, fn) {
  const prev = _gameLocks.get(key) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  _gameLocks.set(key, current);
  try { return await current; } finally {
    if (_gameLocks.get(key) === current) _gameLocks.delete(key);
  }
}

/**
 * Parse a bet amount from AI tool input. If `error` is set, the caller should
 * return it as the tool result; otherwise `amount` is a validated whole number.
 * Typed as a discriminated union so a truthy-`error` early return narrows
 * `amount` to a defined number at the call sites.
 *
 * @param {unknown} raw
 * @param {number} [minBet]
 * @returns {{ error: string, amount?: never } | { error?: never, amount: number }}
 */
function parseBet(raw, minBet = 1) {
  // Reject non-number types up front — Number() coerces booleans, arrays,
  // empty strings, etc. to numbers in ways users don't intend.
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { error: "amount must be a plain number" };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Only allow digits (optional thousands separators). Rejects "1e5", "0x10", "".
    if (!/^\d+(?:,\d{3})*$/.test(trimmed)) {
      return { error: "amount must be digits only" };
    }
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: "amount must be a whole number" };
  if (n < minBet) return { error: `minimum bet is ${minBet} coin${minBet === 1 ? "" : "s"}` };
  if (n > MAX_BET) return { error: `max bet is ${MAX_BET.toLocaleString()} coins` };
  return { amount: n };
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "coinflip_bet": {
      const parsed = parseBet(input.amount);
      if (parsed.error != null) return parsed.error;
      const amount = parsed.amount;
      const choice = (input.choice || "").toLowerCase().trim();
      if (!["heads", "tails"].includes(choice)) return "pick heads or tails";
      // Atomic stake debit — closes the check-then-update race so two parallel
      // coinflip_bet tool calls can't both pass the balance check before either
      // debit lands. Matches the roulette pattern.
      const debit = await db.tryDeductBalance(message.author.id, amount, "gamble_coinflip_stake", `coinflip:${choice}`);
      if (!debit.ok) {
        if (debit.reason === "insufficient") return `you only have ${debit.balance} coins, can't bet ${amount}`;
        return `couldn't place bet: ${debit.reason}`;
      }
      const { randomQuip, getMoodAdjustedOdds, getMoodFlavor } = await import("../gambling.js");
      const { coinflipEmbed } = await import("../gameVisuals.js");
      // Mood-adjusted odds — Eris tilts the coinflip based on her mood
      const mood = db.getMood();
      const winChance = getMoodAdjustedOdds(0.5, mood.mood_score);
      const result = Math.random() < winChance ? choice : (choice === "heads" ? "tails" : "heads");
      const won = result === choice;
      // Stake already deducted. On win, credit 2× stake (refund + winnings).
      let newBalance = debit.newBalance;
      if (won) {
        try {
          newBalance = await db.updateBalance(message.author.id, amount * 2, "gamble_win", `coinflip:${choice}`);
        } catch (err) {
          log(`[coinflip_bet] win credit failed for ${message.author.id}: ${err?.message || err}`);
        }
      }
      await db.recordGameResult(message.author.id, "coinflip", won, amount, won ? amount * 2 : 0);
      const { animateEmbed } = await import("../gameVisuals.js");
      const { EmbedBuilder } = await import("discord.js");
      const { embed: cfEmbed, row: cfRow } = coinflipEmbed(choice, result, won, amount, newBalance);
      // Animated coin flip
      await animateEmbed(message.channel, [
        { embed: new EmbedBuilder().setColor(0x2b2d31).setTitle("\u{1FA99} Flipping...").setDescription("\u{1FA99}") },
        { embed: new EmbedBuilder().setColor(0x2b2d31).setTitle("\u{1FA99} Flipping...").setDescription("\u{1F4AB}") },
        { embed: cfEmbed, components: [cfRow] },
      ], 600);
      return "[game started]";
    }

    case "dice_roll_bet": {
      const parsed = parseBet(input.amount);
      if (parsed.error != null) return parsed.error;
      const amount = parsed.amount;
      const guess = Math.floor(input.guess || 0);
      // If no guess provided, show interactive buttons (no debit — bet hasn't
      // been placed yet, the button click is what commits).
      if (guess < 1 || guess > 6) {
        const econ = await db.getBalance(message.author.id);
        if (econ.balance < amount) return `you only have ${econ.balance} coins`;
        const { diceButtonsEmbed } = await import("../gameVisuals.js");
        const { embed: dbEmbed, row: dbRow } = diceButtonsEmbed(amount);
        await message.channel.send({ embeds: [dbEmbed], components: [dbRow] });
        return "[game started]";
      }
      // Atomic stake debit — closes the check-then-update race.
      const debit = await db.tryDeductBalance(message.author.id, amount, "gamble_dice_stake", `dice:${guess}`);
      if (!debit.ok) {
        if (debit.reason === "insufficient") return `you only have ${debit.balance} coins`;
        return `couldn't place bet: ${debit.reason}`;
      }
      const { randomQuip } = await import("../gambling.js");
      const { diceEmbed, diceAnimFrames, animateEmbed } = await import("../gameVisuals.js");
      // Animated dice roll
      const roll = Math.floor(Math.random() * 6) + 1;
      const frames = diceAnimFrames(roll);
      const won = roll === guess;
      // Stake already deducted. On win, credit 5× stake (refund + 4× winnings)
      // to preserve net payout of +amount*4 from the original semantics.
      let newBalance = debit.newBalance;
      if (won) {
        try {
          newBalance = await db.updateBalance(message.author.id, amount * 5, "gamble_win", `dice:${guess}`);
        } catch (err) {
          log(`[dice_roll_bet] win credit failed for ${message.author.id}: ${err?.message || err}`);
        }
      }
      await db.recordGameResult(message.author.id, "dice", won, amount, won ? amount * 5 : 0);
      // Play animation then show result
      const diceResultEmbed = diceEmbed(guess, roll, won, amount, newBalance);
      frames.push({ embed: diceResultEmbed });
      await animateEmbed(message.channel, frames, 600);
      return "[game started]";
    }

    case "slots_spin": {
      const parsed = parseBet(input.amount);
      if (parsed.error != null) return parsed.error;
      const amount = parsed.amount;
      // Atomic stake debit — closes the check-then-update race.
      const debit = await db.tryDeductBalance(message.author.id, amount, "gamble_slots_stake", "slots:spin");
      if (!debit.ok) {
        if (debit.reason === "insufficient") return `you only have ${debit.balance} coins`;
        return `couldn't place bet: ${debit.reason}`;
      }
      const { spinSlots, slotsPayout } = await import("../gambling.js");
      const { slotsEmbed, slotsAnimFrames, animateEmbed } = await import("../gameVisuals.js");
      // Eris rigs the machine based on her mood and how she feels about the user
      const mood = db.getMood();
      const rel = db.getRelationship(message.author.id);
      const reels = spinSlots(mood.mood_score, rel.affinity_score);
      const { multiplier, label } = slotsPayout(reels);
      // Stake already debited; compute the credit relative to that debit so the
      // net change matches the original `multiplier`-based payout semantics:
      //   multiplier=-2 (double-skull) → additional -amount (total -2× stake)
      //   multiplier=0  (skull / no match) → 0 (stake already lost)
      //   multiplier=1  (push) → +amount (refund stake)
      //   multiplier>1  (win) → +amount * multiplier (refund + winnings)
      const credit = multiplier === -2
        ? -amount
        : multiplier <= 0
          ? 0
          : amount * multiplier;
      const won = multiplier > 1;
      let newBalance = debit.newBalance;
      if (credit !== 0) {
        try {
          newBalance = await db.updateBalance(message.author.id, credit, won ? "gamble_win" : "gamble_loss", `slots:${label}`);
        } catch (err) {
          log(`[slots_spin] credit failed for ${message.author.id}: ${err?.message || err}`);
        }
      }
      await db.recordGameResult(message.author.id, "slots", won, amount, won ? amount * multiplier : 0);
      // Animated reel spin then final result
      const animFrames = slotsAnimFrames(reels);
      const { embed: slEmbed, row: slRow } = slotsEmbed(reels, label, multiplier, amount, won, newBalance);
      animFrames.push({ embed: slEmbed, components: [slRow] });
      await animateEmbed(message.channel, animFrames, 700);
      return "[game started]";
    }

    case "blackjack_start": {
      const parsed = parseBet(input.amount);
      if (parsed.error != null) return parsed.error;
      const amount = parsed.amount;
      const existing = db.getActiveGame(message.channel.id, message.author.id, "blackjack");
      if (existing) return "you already have an active blackjack game \u2014 say 'hit' or 'stand'";
      // Escrow the stake at hand start so a player can't drain their wallet
      // mid-hand to dodge the loss. Settlement (win/push/double) credits back
      // the appropriate amount; on loss the stake is already gone.
      const debit = await db.tryDeductBalance(message.author.id, amount, "gamble_blackjack_stake", "blackjack");
      if (!debit.ok) return `you only have ${debit.balance ?? 0} coins`;
      const { createDeck, handValue, isBlackjack, randomQuip } = await import("../gambling.js");
      const { blackjackDealEmbed, blackjackResultEmbed } = await import("../gameVisuals.js");
      const deck = createDeck();
      const playerHand = [deck.pop(), deck.pop()];
      const dealerHand = [deck.pop(), deck.pop()];
      // Check for natural blackjack
      if (isBlackjack(playerHand)) {
        const payout = Math.floor(amount * 1.5);
        // Stake already escrowed \u2014 refund it AND add the 1.5x winnings.
        const newBalance = await db.updateBalance(message.author.id, amount + payout, "gamble_win", "blackjack:natural");
        await db.recordGameResult(message.author.id, "blackjack", true, amount, amount + payout);
        const { animateEmbed } = await import("../gameVisuals.js");
        const { EmbedBuilder } = await import("discord.js");
        const embed = blackjackResultEmbed(playerHand, dealerHand, 21, handValue(dealerHand), "BLACKJACK!", payout, amount, newBalance, true);
        await animateEmbed(message.channel, [
          { embed: new EmbedBuilder().setColor(0xFFD700).setTitle("\u{1F0CF} Blackjack").setDescription("Dealing cards...") },
          { embed: new EmbedBuilder().setColor(0xFFD700).setTitle("\u{1F0CF} BLACKJACK!").setDescription("# \u{1F389} NATURAL 21!") },
          { embed },
        ], 800);
        return "[game started]";
      }
      db.saveActiveGame(message.channel.id, message.author.id, "blackjack", { deck, playerHand, dealerHand, doubled: false }, amount);
      const { embed, row } = blackjackDealEmbed(playerHand, dealerHand, handValue(playerHand), amount);
      await message.channel.send({ embeds: [embed], components: [row] });
      return "[game started]";
    }

    case "blackjack_action": {
      const action = (input.action || "").toLowerCase().trim();
      if (!["hit", "stand", "double"].includes(action)) return "say 'hit', 'stand', or 'double'";
      const lockKey = `blackjack:${message.channel.id}:${message.author.id}`;
      return withGameLock(lockKey, async () => {
        const game = db.getActiveGame(message.channel.id, message.author.id, "blackjack");
        if (!game) return "no active blackjack game \u2014 start one first";
        const { handValue, randomQuip } = await import("../gambling.js");
        const { blackjackHitEmbed, blackjackResultEmbed } = await import("../gameVisuals.js");
        const { deck, playerHand, dealerHand } = game.gameState;
        let stake = game.stake;
        if (action === "double") {
          // Escrow the additional stake for the double-down. If the player
          // can't cover it, reject the double (the original game stays open).
          const extra = await db.tryDeductBalance(message.author.id, game.stake, "gamble_blackjack_stake", "blackjack:double");
          if (!extra.ok) return `can't double \u2014 you only have ${extra.balance ?? 0} coins`;
          stake *= 2;
          playerHand.push(deck.pop());
        } else if (action === "hit") {
          playerHand.push(deck.pop());
          if (handValue(playerHand) < 21) {
            db.saveActiveGame(message.channel.id, message.author.id, "blackjack", { deck, playerHand, dealerHand, doubled: false }, game.stake);
            const { embed, row } = blackjackHitEmbed(playerHand, dealerHand, handValue(playerHand), game.stake);
            await message.channel.send({ embeds: [embed], components: [row] });
            return "hit or stand?";
          }
        }
        db.deleteActiveGame(message.channel.id, message.author.id, "blackjack");
        const playerValue = handValue(playerHand);
        if (playerValue > 21) {
          // Stake already escrowed at start/double — nothing more to debit.
          const econ = await db.getBalance(message.author.id);
          await db.recordGameResult(message.author.id, "blackjack", false, stake, 0);
          await message.channel.send({ embeds: [blackjackResultEmbed(playerHand, dealerHand, playerValue, handValue(dealerHand), "BUST!", -stake, stake, econ.balance)] });
          return await randomQuip({ won: false, game: "blackjack", amount: stake });
        }
        while (handValue(dealerHand) < 17) dealerHand.push(deck.pop());
        const dealerValue = handValue(dealerHand);
        let resultText, won;
        if (dealerValue > 21) { resultText = "Dealer Busts!"; won = true; }
        else if (playerValue > dealerValue) { resultText = "You Win!"; won = true; }
        else if (playerValue < dealerValue) { resultText = "Dealer Wins"; won = false; }
        else { resultText = "Push (Tie)"; won = null; }
        // Stake already escrowed: on win credit 2× (refund + winnings), on push
        // refund the stake, on loss the stake stays gone (no further debit).
        const credit = won === true ? stake * 2 : won === null ? stake : 0;
        const newBalance = credit > 0
          ? await db.updateBalance(message.author.id, credit, won ? "gamble_win" : "gamble_push", `blackjack:${resultText}`)
          : (await db.getBalance(message.author.id)).balance;
        if (won !== null) await db.recordGameResult(message.author.id, "blackjack", won, stake, won ? stake * 2 : 0);
        const payout = won === true ? stake : won === false ? -stake : 0;
        await message.channel.send({ embeds: [blackjackResultEmbed(playerHand, dealerHand, playerValue, dealerValue, resultText, payout, stake, newBalance)] });
        return await randomQuip({ won: !!won, game: "blackjack", amount: stake });
      });
    }

    case "rob_user": {
      const targetName = input.target || input.username;
      if (!targetName) return "who are you trying to rob?";
      const guild = message.guild;
      if (!guild) return "you can only rob people in a server";
      const target = await resolveMember(guild, targetName);
      if (!target) return `couldn't find user "${targetName}"`;
      if (target.id === message.author.id) return "you can't rob yourself (nice try though)";
      if (target.user.bot) return "you can't rob a bot, they're broke anyway";

      // Atomic cooldown acquire — prevents parallel rob-spam bypassing the 1h gate.
      const cd = db.tryAcquireCooldown(message.author.id, "rob", 60 * 60_000);
      if (cd.onCooldown) {
        return `rob cooldown — try again in ${Math.ceil(cd.remainingMs / 60_000)} minutes`;
      }

      const victim = await db.getBalance(target.id);
      if (victim.balance < 10) return `${target.displayName} is too broke to rob (they have ${victim.balance} coins)`;
      const robber = await db.getBalance(message.author.id);
      const { randomQuip } = await import("../gambling.js");

      // 40% success rate
      const success = Math.random() < 0.4;
      if (success) {
        const stolen = Math.min(Math.floor(victim.balance * (0.1 + Math.random() * 0.2)), 500);
        // Use the atomic two-user primitive so two parallel rob_users on the
        // same victim can't both read the pre-rob balance and each take 10%.
        const result = await db.transferBalance(target.id, message.author.id, stolen, 0, "rob_victim", `by ${message.author.username}`);
        if (!result.ok) {
          if (result.reason === "insufficient") {
            return `${target.displayName} doesn't have ${stolen} coins anymore — someone else got there first`;
          }
          return `rob failed: ${result.reason}`;
        }
        const robberNewBal = (await db.getBalance(message.author.id)).balance;
        const { robEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [robEmbed(true, message.author.displayName, target.displayName, stolen, robberNewBal)] });
        return await randomQuip();
      } else {
        const fine = Math.floor(robber.balance * (0.1 + Math.random() * 0.1));
        const newBalance = await db.updateBalance(message.author.id, -fine, "rob_fail", `failed robbing ${target.displayName}`);
        const { robEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [robEmbed(false, message.author.displayName, target.displayName, fine, newBalance)] });
        return await randomQuip();
      }
    }

    case "russian_roulette": {
      const parsed = parseBet(input.stake);
      if (parsed.error != null) return parsed.error;
      const stake = parsed.amount;
      // Atomic stake debit \u2014 closes the check-then-update race. Stake is
      // pre-deducted; on survival we refund the stake AND add the winnings.
      const debit = await db.tryDeductBalance(message.author.id, stake, "russian_roulette_stake", "russian_roulette");
      if (!debit.ok) {
        if (debit.reason === "insufficient") return `you only have ${debit.balance} coins`;
        return `couldn't place bet: ${debit.reason}`;
      }
      const { rouletteEmbed, animateEmbed } = await import("../gameVisuals.js");
      const { EmbedBuilder } = await import("discord.js");
      const dead = Math.random() < (1 / 6);
      // Animated suspense: spinning chamber
      const suspenseFrames = [
        { embed: new EmbedBuilder().setColor(0x2b2d31).setTitle("\u{1F52B} Russian Roulette").setDescription("*spinning the chamber...*") },
        { embed: new EmbedBuilder().setColor(0x2b2d31).setTitle("\u{1F52B} Russian Roulette").setDescription("*click...*") },
        { embed: new EmbedBuilder().setColor(dead ? 0xEF4444 : 0x10B981).setTitle("\u{1F52B} Russian Roulette").setDescription(dead ? "# \u{1F480} BANG!" : "# \u{1F62E}\u200D\u{1F4A8} *click*... empty") },
      ];
      let newBalance = debit.newBalance;
      if (dead) {
        await db.recordGameResult(message.author.id, "russian_roulette", false, stake, 0);
        const { embed: rrDeadEmbed, row: rrDeadRow } = rouletteEmbed(false, stake, 0, newBalance);
        suspenseFrames.push({ embed: rrDeadEmbed, components: [rrDeadRow] });
      } else {
        const winnings = Math.floor(stake * 0.5);
        // Refund stake (+stake) and add winnings. Original semantics: survival
        // is a net +winnings to the user's balance.
        try {
          newBalance = await db.updateBalance(message.author.id, stake + winnings, "gamble_win", "russian_roulette:survived");
        } catch (err) {
          log(`[russian_roulette] win credit failed for ${message.author.id}: ${err?.message || err}`);
        }
        await db.recordGameResult(message.author.id, "russian_roulette", true, stake, stake + winnings);
        const { embed: rrLiveEmbed, row: rrLiveRow } = rouletteEmbed(true, stake, winnings, newBalance);
        suspenseFrames.push({ embed: rrLiveEmbed, components: [rrLiveRow] });
      }
      await animateEmbed(message.channel, suspenseFrames, 900);
      return "[game started]";
    }

    case "rps_play": {
      const choice = (input.choice || "").toLowerCase().trim();
      let stake = 0;
      const stakeRaw = input.stake ?? input.amount;
      if (stakeRaw != null && Number(stakeRaw) > 0) {
        const parsed = parseBet(stakeRaw);
        if (parsed.error != null) return parsed.error;
        stake = parsed.amount;
      }
      // If no choice provided, show interactive buttons (no debit — the button
      // click is what commits the stake).
      if (!["rock", "paper", "scissors"].includes(choice)) {
        if (stake > 0) {
          const econ = await db.getBalance(message.author.id);
          if (econ.balance < stake) return `you only have ${econ.balance} coins`;
        }
        const { rpsButtonsEmbed } = await import("../gameVisuals.js");
        const { embed: rpsE, row: rpsR } = rpsButtonsEmbed(stake);
        await message.channel.send({ embeds: [rpsE], components: [rpsR] });
        return "[game started]";
      }
      // Atomic stake debit (only if there's a stake) — closes the
      // check-then-update race for staked play.
      let debit = null;
      if (stake > 0) {
        debit = await db.tryDeductBalance(message.author.id, stake, "gamble_rps_stake", `rps:${choice}`);
        if (!debit.ok) {
          if (debit.reason === "insufficient") return `you only have ${debit.balance} coins`;
          return `couldn't place bet: ${debit.reason}`;
        }
      }
      const { randomQuip } = await import("../gambling.js");
      const { rpsResultEmbed, animateEmbed } = await import("../gameVisuals.js");
      const options = ["rock", "paper", "scissors"];
      const botChoice = options[Math.floor(Math.random() * 3)];
      const wins = { rock: "scissors", paper: "rock", scissors: "paper" };
      let result;
      if (choice === botChoice) result = "tie";
      else if (wins[choice] === botChoice) result = "win";
      else result = "lose";
      let newBalance = debit ? debit.newBalance : 0;
      if (stake > 0) {
        // Stake already deducted. On win: credit 2× stake (refund + winnings).
        // On tie: refund stake. On loss: stake stays gone.
        const credit = result === "win" ? stake * 2 : result === "tie" ? stake : 0;
        if (credit !== 0) {
          try {
            newBalance = await db.updateBalance(message.author.id, credit, result === "win" ? "gamble_win" : "gamble_push", `rps:${choice}`);
          } catch (err) {
            log(`[rps_play] credit failed for ${message.author.id}: ${err?.message || err}`);
          }
        }
        if (result !== "tie") {
          await db.recordGameResult(message.author.id, "rps", result === "win", stake, result === "win" ? stake * 2 : 0);
        }
      }
      // Animated countdown then result
      const countdownFrames = [
        { embed: new (await import("discord.js")).EmbedBuilder().setColor(0x2b2d31).setTitle("\u270A Rock Paper Scissors").setDescription("# 3...") },
        { embed: new (await import("discord.js")).EmbedBuilder().setColor(0x2b2d31).setTitle("\u270A Rock Paper Scissors").setDescription("# 2...") },
        { embed: new (await import("discord.js")).EmbedBuilder().setColor(0x2b2d31).setTitle("\u270A Rock Paper Scissors").setDescription("# 1...") },
      ];
      const resultEmbed = rpsResultEmbed(choice, botChoice, result, stake, newBalance);
      countdownFrames.push({ embed: resultEmbed.embed, components: [resultEmbed.row] });
      await animateEmbed(message.channel, countdownFrames, 700);
      return "[game started]";
    }

    default:
      return undefined;
  }
}
