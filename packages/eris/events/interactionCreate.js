import { log } from "../utils/logger.js";
import { MessageFlags } from "discord.js";
import * as db from "../database.js";

// In-flight interaction guard for re-entrant game buttons. The economy lock
// in database.js already serializes the mutations, but it does so by queuing —
// a user spamming "hit" 5 times in 200ms still triggers 5 handler invocations,
// 4 of which would race to the "no active game" branch (and one of which, for
// the bj_double path, could double-deduct if the timing lined up between the
// stake mutation and the game-state delete). Reject re-entrant presses at the
// door so the second click sees a clear "still processing" message instead.
const _inflightGameKeys = new Set();
const _claimedActivityEvents = new Set();

export default async function interactionCreate(interaction) {
  // ─── Button interactions (games) ──────────────────────────────────────
  if (interaction.isButton()) {
    try {
      await handleGameButton(interaction);
    } catch (error) {
      log(`[BTN] Error: ${error.message}`);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "something broke — try again in a sec", flags: MessageFlags.Ephemeral });
        }
      } catch (e) { log(`[INTERACT] ${e.message}`); }
    }
    return;
  }

  // ─── Select menu interactions ─────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    try {
      await handleSelectMenu(interaction);
    } catch (error) {
      log(`[SELECT] Error: ${error.message}`);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "something broke — try again in a sec", flags: MessageFlags.Ephemeral });
        }
      } catch (e) { log(`[INTERACT] ${e.message}`); }
    }
    return;
  }

  // ─── Modal submissions ────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    try {
      // Route by customId prefix — e.g. "report_modal:userId"
      const [action] = interaction.customId.split(":");
      const handler = interaction.client.modalHandlers?.get(action);
      if (handler) {
        await handler(interaction);
      } else {
        log(`[MODAL] No handler for modal '${action}'`);
        if (!interaction.replied) await interaction.reply({ content: "that modal isn't wired up yet", flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      log(`[MODAL] Error: ${error.message}`);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "something went wrong", flags: MessageFlags.Ephemeral }); } catch (e) { log(`[INTERACT] ${e.message}`); }
    }
    return;
  }

  if (!interaction.isCommand()) return;

  const command = interaction.client.commands?.get(interaction.commandName);
  if (!command) return;

  try {
    // Auto-defer after 2.5s if the command hasn't replied yet.
    // This prevents "interaction failed" on slow AI/DB commands while
    // keeping fast commands snappy (no unnecessary "thinking..." flash).
    const deferTimer = setTimeout(() => {
      if (!interaction.replied && !interaction.deferred) {
        interaction.deferReply().catch(() => {});
      }
    }, 2500);

    try {
      await command.execute(interaction, interaction.client);
    } finally {
      clearTimeout(deferTimer);
    }
  } catch (error) {
    log(`[CMD] Error in /${interaction.commandName}: ${error.message}`);
    const reply = { content: "something broke lol", flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
}

// ─── Game Button Handler ────────────────────────────────────────────────────

async function handleGameButton(interaction) {
  const id = interaction.customId;
  const userId = interaction.user.id;
  const channelId = interaction.channel.id;

  // ── Blackjack buttons ─────────────────────────────────────────────────
  // Two-layer defense against rapid-click double-spend:
  //   1. _inflightGameKeys reject the second click immediately so it never
  //      starts a duplicate handler invocation. Cleared in a finally block.
  //   2. db.withUserLock still serializes inside, so if anything else (the
  //      AI text path, /gamble commands) is mutating this user's balance
  //      concurrently, the bj logic still observes a consistent state.
  // The combination prevents the previous failure mode where a fast
  // double-click on "double" could pass the balance check twice before the
  // first deduct landed, and the rare race where two parallel handlers both
  // saw the same active game and each resolved it.
  if (id === "bj_hit" || id === "bj_stand" || id === "bj_double") {
    const gameKey = `bj:${channelId}:${userId}`;
    if (_inflightGameKeys.has(gameKey)) {
      // Re-entrant click while the previous one is still processing — reject
      // ephemerally so the user gets clear feedback instead of a silent queue.
      return interaction.reply({ content: "still processing your last move, hang on", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    _inflightGameKeys.add(gameKey);
    try {
      return await db.withUserLock(userId, async () => {
        const game = db.getActiveGame(channelId, userId, "blackjack");
        if (!game) return interaction.reply({ content: "you don't have an active blackjack game", flags: MessageFlags.Ephemeral });

        const { handValue, randomQuip } = await import("../ai/gambling.js");
        const { blackjackHitEmbed, blackjackResultEmbed } = await import("../ai/gameVisuals.js");
        const { deck, playerHand, dealerHand } = game.gameState;
        let stake = game.stake;

        if (id === "bj_double") {
          // Use the unsafe variant — outer withUserLock is already held.
          const deduct = await db.tryDeductBalanceUnsafe(userId, stake, "gamble_double", "blackjack:double");
          if (!deduct.ok) {
            if (deduct.reason === "insufficient") {
              return interaction.reply({ content: `can't double — you only have ${deduct.balance} coins. hit or stand instead`, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: `can't double right now: ${deduct.reason}`, flags: MessageFlags.Ephemeral });
          }
          stake *= 2;
          playerHand.push(deck.pop());
        } else if (id === "bj_hit") {
          playerHand.push(deck.pop());
          const pv = handValue(playerHand);
          if (pv < 21) {
            // Still playing — update game and show new hand
            db.saveActiveGame(channelId, userId, "blackjack", { deck, playerHand, dealerHand }, game.stake);
            const { embed, row } = blackjackHitEmbed(playerHand, dealerHand, pv, game.stake);
            return interaction.update({ embeds: [embed], components: [row] });
          }
          // 21 or bust — fall through to resolve
        }

        // ── Resolve the hand ──────────────────────────────────────────────
        db.deleteActiveGame(channelId, userId, "blackjack");
        const playerValue = handValue(playerHand);

        if (playerValue > 21) {
          const newBalance = (await db.getBalance(userId)).balance;
          await db.recordGameResult(userId, "blackjack", false, stake, 0);
          const embed = blackjackResultEmbed(playerHand, dealerHand, playerValue, handValue(dealerHand), "BUST!", -stake, stake, newBalance);
          const quip = await randomQuip({ won: false, game: "blackjack", amount: stake });
          return interaction.update({ embeds: [embed], components: [], content: quip });
        }

        // Dealer plays
        while (handValue(dealerHand) < 17) dealerHand.push(deck.pop());
        const dealerValue = handValue(dealerHand);

        let resultText, won;
        if (dealerValue > 21) { resultText = "Dealer Busts!"; won = true; }
        else if (playerValue > dealerValue) { resultText = "You Win!"; won = true; }
        else if (playerValue < dealerValue) { resultText = "Dealer Wins"; won = false; }
        else { resultText = "Push (Tie)"; won = null; }

        const credit = won === true ? stake * 2 : won === null ? stake : 0;
        const newBalance = credit > 0
          ? await db.updateBalanceUnsafe(userId, credit, won ? "gamble_win" : "gamble_push", `blackjack:${resultText}`)
          : (await db.getBalance(userId)).balance;
        if (won !== null) await db.recordGameResult(userId, "blackjack", won, stake, won ? stake * 2 : 0);

        const payout = won === true ? stake : won === false ? -stake : 0;
        const embed = blackjackResultEmbed(playerHand, dealerHand, playerValue, dealerValue, resultText, payout, stake, newBalance);
        const quip = await randomQuip({ won: !!won, game: "blackjack", amount: stake });
        return interaction.update({ embeds: [embed], components: [], content: quip });
      });
    } finally {
      _inflightGameKeys.delete(gameKey);
    }
  }

  // ── Trivia buttons ────────────────────────────────────────────────────
  if (id.startsWith("trivia_")) {
    const answer = id.replace("trivia_", "");
    const game = db.getActiveGame(channelId, userId, "trivia");
    if (!game) return interaction.reply({ content: "you don't have an active trivia question", flags: MessageFlags.Ephemeral });

    const labels = ["A", "B", "C", "D"];
    const idx = labels.indexOf(answer);
    if (idx === -1) return;

    db.deleteActiveGame(channelId, userId, "trivia");
    const correct = idx === game.gameState.correctIndex;
    const correctAnswer = game.gameState.answers[game.gameState.correctIndex];
    await db.recordTriviaResult(userId, correct);

    let payout = 0;
    if (game.stake > 0) {
      const multiplier = game.gameState.difficulty === "hard" ? 3 : game.gameState.difficulty === "medium" ? 2 : 1.5;
      payout = correct ? Math.floor(game.stake * (multiplier - 1)) : -game.stake;
      await db.updateBalance(userId, payout, correct ? "gamble_win" : "gamble_loss", `trivia:${correct}`);
    }

    const stats = await db.getTriviaStats(userId);
    const { triviaResultEmbed } = await import("../ai/gameVisuals.js");
    const embed = triviaResultEmbed(correct, game.gameState.question, correctAnswer, answer, stats, payout);
    return interaction.update({ embeds: [embed], components: [] });
  }

  // ── Duel accept button → Strategic move selection ──────────────────────
  if (id.startsWith("duel_accept_")) {
    const targetId = id.replace("duel_accept_", "");
    if (userId !== targetId) return interaction.reply({ content: "this duel isn't for you", flags: MessageFlags.Ephemeral });

    const duel = db.getPendingDuel(channelId, userId);
    if (!duel) return interaction.reply({ content: "this duel expired", flags: MessageFlags.Ephemeral });

    const resolved = db.resolveDuel(channelId, userId);
    if (!resolved) return interaction.reply({ content: "duel not found", flags: MessageFlags.Ephemeral });

    // Save duel state for move selection
    const duelKey = `${channelId}_${resolved.challengerId}_${resolved.targetId}`;
    if (!globalThis._pendingDuelMoves) globalThis._pendingDuelMoves = new Map();
    globalThis._pendingDuelMoves.set(duelKey, { ...resolved, moves: {}, timestamp: Date.now() });

    const { duelCountdownFrames, animateEmbed } = await import("../ai/gameVisuals.js");
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");

    // Animate countdown
    const guild = interaction.guild;
    const challengerName = guild?.members.cache.get(resolved.challengerId)?.displayName || "Challenger";
    const targetName = guild?.members.cache.get(resolved.targetId)?.displayName || "Target";
    const frames = duelCountdownFrames(challengerName, targetName);
    await interaction.update({ embeds: [frames[0].embed], components: [] });
    for (let i = 1; i < frames.length; i++) {
      await new Promise(r => setTimeout(r, 800));
      await interaction.editReply({ embeds: [frames[i].embed] });
    }

    // Show move selection buttons for both players
    await new Promise(r => setTimeout(r, 500));
    const moveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`duel_move_attack_${duelKey}`).setLabel("Attack").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`duel_move_defend_${duelKey}`).setLabel("Defend").setEmoji("🛡️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`duel_move_feint_${duelKey}`).setLabel("Feint").setEmoji("💨").setStyle(ButtonStyle.Secondary),
    );
    const moveEmbed = new EmbedBuilder()
      .setColor(0x9333EA)
      .setTitle("⚔️ Choose Your Move!")
      .setDescription(`**${challengerName}** vs **${targetName}**\n\n⚔️ Attack beats 💨 Feint\n💨 Feint beats 🛡️ Defend\n🛡️ Defend beats ⚔️ Attack\n\nBoth players: pick your move!`)
      .setFooter({ text: `Stake: ${resolved.stake} coins • 30 seconds to choose` });
    await interaction.editReply({ embeds: [moveEmbed], components: [moveRow] });

    // Auto-resolve after 30s if someone hasn't picked
    setTimeout(async () => {
      const pending = globalThis._pendingDuelMoves?.get(duelKey);
      if (!pending || Object.keys(pending.moves).length >= 2) return;
      // Auto-pick random moves for missing players
      const moves = ["attack", "defend", "feint"];
      if (!pending.moves[pending.challengerId]) pending.moves[pending.challengerId] = moves[Math.floor(Math.random() * 3)];
      if (!pending.moves[pending.targetId]) pending.moves[pending.targetId] = moves[Math.floor(Math.random() * 3)];
      await resolveDuelMoves(interaction, duelKey);
    }, 30_000);

    return;
  }

  // ── Duel move selection ──────────────────────────────────────────────
  if (id.startsWith("duel_move_")) {
    const parts = id.split("_"); // duel_move_attack_channelId_challengerId_targetId
    const move = parts[2]; // attack, defend, or feint
    const duelKey = parts.slice(3).join("_");

    if (!globalThis._pendingDuelMoves) return interaction.reply({ content: "no active duel", flags: MessageFlags.Ephemeral });
    const pending = globalThis._pendingDuelMoves.get(duelKey);
    if (!pending) return interaction.reply({ content: "this duel expired", flags: MessageFlags.Ephemeral });

    // Verify this player is part of the duel
    if (userId !== pending.challengerId && userId !== pending.targetId) {
      return interaction.reply({ content: "this duel isn't for you", flags: MessageFlags.Ephemeral });
    }

    // Record the move
    if (pending.moves[userId]) return interaction.reply({ content: `you already chose **${pending.moves[userId]}**`, flags: MessageFlags.Ephemeral });
    pending.moves[userId] = move;
    await interaction.reply({ content: `you chose **${move}**! waiting for opponent...`, flags: MessageFlags.Ephemeral });

    // If both moves are in, resolve
    if (Object.keys(pending.moves).length >= 2) {
      await resolveDuelMoves(interaction, duelKey);
    }
    return;
  }

  // Helper: if the embed is older than 2 minutes, send new instead of editing
  const embedTooOld = (Date.now() - interaction.message.createdTimestamp) > 2 * 60 * 1000;

  // ── Coinflip replay buttons ─────────────────────────────────────────
  if (id.startsWith("flip_")) {
    const parts = id.split("_"); // flip_heads_50 or flip_tails_50
    const choice = parts[1];
    const amount = Math.max(1, Math.abs(parseInt(parts[2])) || 10);
    if (!["heads", "tails"].includes(choice)) return interaction.reply({ content: "invalid", flags: MessageFlags.Ephemeral });
    // Atomic stake debit — closes the check-then-update race on replay-spam.
    const debit = await db.tryDeductBalance(userId, amount, "gamble_coinflip_stake", `coinflip:${choice}`);
    if (!debit.ok) {
      if (debit.reason === "insufficient") return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
    }
    const { getMoodAdjustedOdds, randomQuip } = await import("../ai/gambling.js");
    const { coinflipEmbed } = await import("../ai/gameVisuals.js");
    const mood = db.getMood();
    const winChance = getMoodAdjustedOdds(0.5, mood.mood_score);
    const result = Math.random() < winChance ? choice : (choice === "heads" ? "tails" : "heads");
    const won = result === choice;
    let newBalance = debit.newBalance;
    if (won) {
      try {
        newBalance = await db.updateBalance(userId, amount * 2, "gamble_win", `coinflip:${choice}`);
      } catch (err) {
        log(`[coinflip button] win credit failed for ${userId}: ${err?.message || err}`);
      }
    }
    await db.recordGameResult(userId, "coinflip", won, amount, won ? amount * 2 : 0);
    const { embed, row } = coinflipEmbed(choice, result, won, amount, newBalance);
    if (embedTooOld) {
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.channel.send({ embeds: [embed], components: [row], content: randomQuip() });
    }
    return interaction.update({ embeds: [embed], components: [row], content: randomQuip() });
  }

  // ── Slots replay button (with animation + rigging) ────────────────
  if (id.startsWith("slots_")) {
    const amount = Math.max(1, Math.abs(parseInt(id.replace("slots_", ""))) || 10);
    // Atomic stake debit — closes the check-then-update race on replay-spam.
    const debit = await db.tryDeductBalance(userId, amount, "gamble_slots_stake", "slots:spin");
    if (!debit.ok) {
      if (debit.reason === "insufficient") return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
    }
    const { spinSlots, slotsPayout } = await import("../ai/gambling.js");
    const { slotsEmbed, slotsAnimFrames, animateEmbedEdit } = await import("../ai/gameVisuals.js");
    // Rig based on mood + affinity
    const mood = db.getMood();
    const rel = db.getRelationship(userId);
    const reels = spinSlots(mood.mood_score, rel.affinity_score);
    const { multiplier, label } = slotsPayout(reels);
    // Stake already debited; compute the credit relative to that debit so the
    // net change matches the original `multiplier`-based payout semantics
    // (see commands/gambling/slots.js for the table).
    const credit = multiplier === -2
      ? -amount
      : multiplier <= 0
        ? 0
        : amount * multiplier;
    const won = multiplier > 1;
    let newBalance = debit.newBalance;
    if (credit !== 0) {
      try {
        newBalance = await db.updateBalance(userId, credit, won ? "gamble_win" : "gamble_loss", `slots:${label}`);
      } catch (err) {
        log(`[slots button] credit failed for ${userId}: ${err?.message || err}`);
      }
    }
    await db.recordGameResult(userId, "slots", won, amount, won ? amount * multiplier : 0);
    const animFrames = slotsAnimFrames(reels);
    const { embed, row } = slotsEmbed(reels, label, multiplier, amount, won, newBalance);
    animFrames.push({ embed, components: [row] });
    if (embedTooOld) {
      await interaction.update({ components: [] }).catch(() => {});
      const { animateEmbed } = await import("../ai/gameVisuals.js");
      await animateEmbed(interaction.channel, animFrames, 700);
    } else {
      await animateEmbedEdit(interaction, animFrames, 700);
    }
    return;
  }

  // ── Roulette replay button (russian roulette) ────────────────────
  if (id.startsWith("roulette_")) {
    const stake = Math.max(1, Math.abs(parseInt(id.replace("roulette_", ""))) || 10);
    // Atomic stake debit — closes the check-then-update race on replay-spam.
    const debit = await db.tryDeductBalance(userId, stake, "russian_roulette_stake", "russian_roulette");
    if (!debit.ok) {
      if (debit.reason === "insufficient") return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
    }
    const { randomQuip } = await import("../ai/gambling.js");
    const { rouletteEmbed } = await import("../ai/gameVisuals.js");
    const dead = Math.random() < (1 / 6);
    if (dead) {
      const newBal = debit.newBalance;
      await db.recordGameResult(userId, "russian_roulette", false, stake, 0);
      const { embed, row } = rouletteEmbed(false, stake, 0, newBal);
      if (embedTooOld) {
        await interaction.update({ components: [] }).catch(() => {});
        return interaction.channel.send({ embeds: [embed], components: [row], content: randomQuip() });
      }
      return interaction.update({ embeds: [embed], components: [row], content: randomQuip() });
    }
    const winnings = Math.floor(stake * 0.5);
    // Refund stake (+stake) plus winnings — original semantics: survival is a
    // net +winnings change on top of an unchanged stake.
    let newBal = debit.newBalance;
    try {
      newBal = await db.updateBalance(userId, stake + winnings, "gamble_win", "russian_roulette:survived");
    } catch (err) {
      log(`[russian roulette button] win credit failed for ${userId}: ${err?.message || err}`);
    }
    await db.recordGameResult(userId, "russian_roulette", true, stake, stake + winnings);
    const { embed, row } = rouletteEmbed(true, stake, winnings, newBal);
    if (embedTooOld) {
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.channel.send({ embeds: [embed], components: [row], content: randomQuip() });
    }
    return interaction.update({ embeds: [embed], components: [row], content: randomQuip() });
  }

  // ── Daily challenge claim button ──────────────────────────────────
  if (id === "challenge_complete") {
    const today = new Date().toISOString().split("T")[0];
    const { getDailyChallenge, completeDailyChallenge, getGameStats, getTriviaStats, getSupabase } = await import("../database.js");
    const challenge = await getDailyChallenge(interaction.guild?.id, today);
    if (!challenge) return interaction.reply({ content: "no challenge today", flags: MessageFlags.Ephemeral });
    if ((challenge.completed_by || []).includes(userId)) return interaction.reply({ content: "already claimed", flags: MessageFlags.Ephemeral });

    // Verify the user actually completed the challenge
    const type = challenge.challenge_type;
    const target = challenge.challenge_target;
    let progress = 0;
    let verified = false;

    if (type === "coinflip_wins") {
      const stats = await getGameStats(userId, "coinflip");
      progress = stats.wins || 0;
      verified = stats.current_streak >= target || progress >= target;
    } else if (type === "dice_wins") {
      const stats = await getGameStats(userId, "dice");
      progress = stats.wins || 0;
      verified = progress >= target;
    } else if (type === "slots_play") {
      const stats = await getGameStats(userId, "slots");
      progress = (stats.wins || 0) + (stats.losses || 0);
      verified = progress >= target;
    } else if (type === "rps_wins") {
      const stats = await getGameStats(userId, "rps");
      progress = stats.wins || 0;
      verified = progress >= target;
    } else if (type === "trivia_correct") {
      const stats = await getTriviaStats(userId);
      progress = stats.correct || 0;
      verified = progress >= target;
    } else if (type === "survive_roulette") {
      const stats = await getGameStats(userId, "russian_roulette");
      progress = stats.wins || 0;
      verified = progress >= target;
    } else if (type === "duel_wins") {
      const stats = await getGameStats(userId, "duel");
      progress = stats.wins || 0;
      verified = progress >= target;
    } else if (type === "total_wagered" || type === "earn_coins" || type === "rob_attempt") {
      const supabase = getSupabase();
      if (supabase) {
        let query = supabase
          .from("eris_transactions")
          .select(type === "rob_attempt" ? "type" : "amount")
          .eq("user_id", userId)
          .gte("created_at", today + "T00:00:00")
          .lt("created_at", today + "T23:59:59.999");
        if (type === "total_wagered") query = query.like("type", "gamble%");
        else if (type === "earn_coins") query = query.gt("amount", 0);
        else query = query.in("type", ["rob_success", "rob_fail", "rob_fine"]);
        const { data: rows } = await query;
        progress = type === "rob_attempt"
          ? (rows || []).length
          : (rows || []).reduce((sum, r) => sum + (type === "total_wagered" ? Math.abs(r.amount) : r.amount), 0);
      }
      verified = progress >= target;
    }

    if (!verified) {
      return interaction.reply({ content: `you haven't completed the challenge yet! you need ${target} but you have ${progress}`, flags: MessageFlags.Ephemeral });
    }

    const newlyCompleted = await completeDailyChallenge(challenge.id, userId);
    if (!newlyCompleted) return interaction.reply({ content: "already claimed", flags: MessageFlags.Ephemeral });
    await db.updateBalance(userId, challenge.reward, "challenge_reward", type);
    const { dailyChallengeEmbed } = await import("../ai/gameVisuals.js");
    const { embed } = dailyChallengeEmbed(challenge, true);
    return interaction.update({ embeds: [embed], components: [], content: `challenge complete! claimed **${challenge.reward}** coins 🎉` });
  }

  // ── Dice Roll Buttons ──────────────────────────────────────────────────────
  if (id.startsWith("dice_")) {
    const parts = id.split("_"); // dice_3_100
    const guess = parseInt(parts[1]);
    const amount = parseInt(parts[2]);
    if (!guess || !amount) return interaction.reply({ content: "invalid dice bet", flags: MessageFlags.Ephemeral });
    // Atomic stake debit — closes the check-then-update race on rapid button taps.
    const debit = await db.tryDeductBalance(userId, amount, "gamble_dice_stake", `dice:${guess}`);
    if (!debit.ok) {
      if (debit.reason === "insufficient") return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
    }
    const { diceEmbed, diceAnimFrames } = await import("../ai/gameVisuals.js");
    const roll = Math.floor(Math.random() * 6) + 1;
    const won = roll === guess;
    // Stake already deducted; credit 5× stake on win for net payout of +4×.
    let newBalance = debit.newBalance;
    if (won) {
      try {
        newBalance = await db.updateBalance(userId, amount * 5, "gamble_win", `dice:${guess}`);
      } catch (err) {
        log(`[dice button] win credit failed for ${userId}: ${err?.message || err}`);
      }
    }
    await db.recordGameResult(userId, "dice", won, amount, won ? amount * 5 : 0);
    const resultEmbed = diceEmbed(guess, roll, won, amount, newBalance);
    const { diceButtonsEmbed, animateEmbedEdit: animDice, animateEmbed: animDiceNew } = await import("../ai/gameVisuals.js");
    const { row: replayRow } = diceButtonsEmbed(amount);
    const diceFrames = diceAnimFrames(roll);
    diceFrames.push({ embed: resultEmbed, components: [replayRow] });
    if (embedTooOld) {
      await interaction.update({ components: [] }).catch(() => {});
      await animDiceNew(interaction.channel, diceFrames, 600);
    } else {
      await animDice(interaction, diceFrames, 600);
    }
    return;
  }

  // ── RPS Buttons ───────────────────────────────────────────────────────────
  if (id.startsWith("rps_")) {
    const parts = id.split("_"); // rps_rock_100
    const choice = parts[1];
    const stake = parseInt(parts[2]) || 0;
    if (!["rock", "paper", "scissors"].includes(choice)) return interaction.reply({ content: "invalid choice", flags: MessageFlags.Ephemeral });
    // Atomic stake debit (only if staked) — closes the check-then-update race.
    let debit = null;
    if (stake > 0) {
      debit = await db.tryDeductBalance(userId, stake, "gamble_rps_stake", `rps:${choice}`);
      if (!debit.ok) {
        if (debit.reason === "insufficient") return interaction.reply({ content: `you only have ${debit.balance} coins`, flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: `couldn't place bet: ${debit.reason}`, flags: MessageFlags.Ephemeral });
      }
    }
    const options = ["rock", "paper", "scissors"];
    const botChoice = options[Math.floor(Math.random() * 3)];
    const wins = { rock: "scissors", paper: "rock", scissors: "paper" };
    let result;
    if (choice === botChoice) result = "tie";
    else if (wins[choice] === botChoice) result = "win";
    else result = "lose";
    let newBalance = debit ? debit.newBalance : 0;
    if (stake > 0) {
      // Stake already deducted. Win → credit 2× (refund + winnings); tie →
      // refund stake; loss → stake stays gone.
      const credit = result === "win" ? stake * 2 : result === "tie" ? stake : 0;
      if (credit !== 0) {
        try {
          newBalance = await db.updateBalance(userId, credit, result === "win" ? "gamble_win" : "gamble_push", `rps:${choice}`);
        } catch (err) {
          log(`[rps button] credit failed for ${userId}: ${err?.message || err}`);
        }
      }
      if (result !== "tie") {
        await db.recordGameResult(userId, "rps", result === "win", stake, result === "win" ? stake * 2 : 0);
      }
    } else {
      const econ = await db.getBalance(userId);
      newBalance = econ.balance;
    }
    const { rpsResultEmbed } = await import("../ai/gameVisuals.js");
    const { embed: rpsE, row: rpsR } = rpsResultEmbed(choice, botChoice, result, stake, newBalance);
    if (embedTooOld) {
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.channel.send({ embeds: [rpsE], components: [rpsR] });
    }
    return interaction.update({ embeds: [rpsE], components: [rpsR] });
  }

  // ── Shop page navigation buttons ─────────────────────────────────────────
  if (id.startsWith("shop_pg_")) {
    const parts = id.split("_"); // shop_pg_catkey_page
    const catKey = parts[2];
    const page = parseInt(parts[3]) || 0;
    const { buildCategoryEmbed, buildCategoryComponents } = await import("../commands/economy/shop.js");
    const [wallet, inv, pet] = await Promise.all([db.getBalance(userId), db.getInventory(userId), db.getPet(userId)]);
    const userItems = new Set((inv || []).map(i => i.item_name));
    const hasPet = !!pet;
    const result = buildCategoryEmbed(catKey, page, wallet.balance, userItems, hasPet);
    if (!result) return interaction.reply({ content: "nothing here", flags: MessageFlags.Ephemeral });
    return interaction.update({ embeds: [result.embed], components: buildCategoryComponents(catKey, page, result.items, result.totalPages, userItems, hasPet) });
  }

  // ── Activity "Again" Buttons ──────────────────────────────────────────────
  if (id.startsWith("again_")) {
    const activity = id.replace("again_", ""); // fish, hunt, dig, work, beg, search
    // If the original message is older than 2 minutes, send a new message instead of editing
    const msgAge = Date.now() - interaction.message.createdTimestamp;
    const tooOld = msgAge > 2 * 60 * 1000;
    try {
      if (tooOld) {
        // Disable the old button and send a fresh activity embed
        await interaction.update({ components: [] }).catch(() => {});
        const { executeActivityTool } = await import("../ai/activityExecutor.js");
        await executeActivityTool(activity, {}, { author: { id: userId }, channel: interaction.channel });
      } else {
        const { executeActivityToolInPlace } = await import("../ai/activityExecutor.js");
        await executeActivityToolInPlace(activity, userId, interaction);
      }
    } catch {
      return interaction.reply({ content: "cooldown or error — try again in a sec", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Word Scramble Buttons ──────────────────────────────────────────────────
  if (id === "scramble_hint") {
    const game = db.getActiveGame(channelId, userId, "word_scramble");
    if (!game) return interaction.reply({ content: "no active word scramble", flags: MessageFlags.Ephemeral });
    const hint = game.gameState.word.substring(0, Math.min(2, game.gameState.word.length));
    return interaction.reply({ content: `hint: starts with **${hint}**...`, flags: MessageFlags.Ephemeral });
  }

  if (id === "scramble_giveup") {
    const game = db.getActiveGame(channelId, userId, "word_scramble");
    if (!game) return interaction.reply({ content: "no active word scramble", flags: MessageFlags.Ephemeral });
    db.deleteActiveGame(channelId, userId, "word_scramble");
    if (game.stake > 0) {
      await db.updateBalance(userId, -game.stake, "gamble_loss", "word_scramble:giveup");
    }
    const { wordScrambleResultEmbed } = await import("../ai/gameVisuals.js");
    return interaction.update({ embeds: [wordScrambleResultEmbed(false, game.gameState.word, game.gameState.attempts, game.stake)], components: [] });
  }

  // ── Number Guess Buttons ──────────────────────────────────────────────────
  if (id === "numguess_giveup") {
    const game = db.getActiveGame(channelId, userId, "number_guess");
    if (!game) return interaction.reply({ content: "no active number game", flags: MessageFlags.Ephemeral });
    db.deleteActiveGame(channelId, userId, "number_guess");
    if (game.stake > 0) {
      await db.updateBalance(userId, -game.stake, "gamble_loss", "number_guess:giveup");
    }
    const { numberGuessResultEmbed } = await import("../ai/gameVisuals.js");
    return interaction.update({ embeds: [numberGuessResultEmbed(false, game.gameState.secret, game.gameState.attempts, game.stake)], components: [] });
  }

  // ── Duel Rematch Button ───────────────────────────────────────────────────
  if (id.startsWith("duel_rematch_")) {
    return interaction.reply({ content: `challenge them again with a duel!`, flags: MessageFlags.Ephemeral });
  }

  // ── Boss Attack Button ────────────────────────────────────────────────────
  if (id === "boss_attack") {
    try {
      const { executeTool } = await import("../ai/executor.js");
      // Synthesize a message whose author/member/guild are the CLICKER, not the
      // bot that posted the embed — otherwise every click is mis-credited and
      // the bot's balance is debited. Sub-executors read author/member/guild
      // off the passed message. `channel` is a prototype getter on Message and
      // wouldn't survive the spread, so set it explicitly (the executors call
      // message.channel.id / .send).
      const ctx = { ...interaction.message, author: interaction.user, member: interaction.member, guild: interaction.guild, channel: interaction.channel };
      const result = await executeTool("boss_attack", {}, ctx);
      return interaction.reply({ content: result, ephemeral: false });
    } catch {
      return interaction.reply({ content: "couldn't attack — try again", flags: MessageFlags.Ephemeral });
    }
  }

  // ── Heist Join Button ─────────────────────────────────────────────────────
  if (id === "heist_join") {
    try {
      const { executeTool } = await import("../ai/executor.js");
      // Synthesize a message attributed to the clicker (see boss_attack above).
      const ctx = { ...interaction.message, author: interaction.user, member: interaction.member, guild: interaction.guild, channel: interaction.channel };
      const result = await executeTool("heist_join", {}, ctx);
      return interaction.reply({ content: result, ephemeral: false });
    } catch {
      return interaction.reply({ content: "couldn't join — try again", flags: MessageFlags.Ephemeral });
    }
  }

  // ── Random Event Buttons (with per-user spam protection) ────────────────
  // Track who already participated in each event message
  if (!globalThis._eventParticipants) globalThis._eventParticipants = new Map();

  if (id.startsWith("event_claim_")) {
    const msgId = interaction.message.id;
    const key = `claim_${msgId}`;
    if (!globalThis._eventParticipants.has(key)) globalThis._eventParticipants.set(key, new Set());
    const participants = globalThis._eventParticipants.get(key);
    if (participants.has(userId)) return interaction.reply({ content: "you already claimed this", flags: MessageFlags.Ephemeral });
    participants.add(userId);
    const amount = parseInt(id.replace("event_claim_", ""));
    if (!amount) return interaction.reply({ content: "invalid event", flags: MessageFlags.Ephemeral });
    await db.updateBalance(userId, amount, "event_reward", "coin_rain");
    return interaction.reply({ content: `💰 <@${userId}> claimed **${amount}** coins from the coin rain!` });
  }

  if (id === "event_quickdraw") {
    // Claim BEFORE the async balance call so two simultaneous clicks can't
    // both pass the claim check and both get paid the 300-coin prize.
    const qdKey = `quickdraw_${interaction.message.id}`;
    if (!globalThis._eventParticipants) globalThis._eventParticipants = new Map();
    if (globalThis._eventParticipants.has(qdKey)) {
      return interaction.reply({ content: "too slow — someone already drew first", flags: MessageFlags.Ephemeral });
    }
    globalThis._eventParticipants.set(qdKey, userId);

    await db.updateBalance(userId, 300, "event_reward", "quick_draw");
    await interaction.update({ components: [] }).catch(() => {});
    return interaction.followUp({ content: `🎯 <@${userId}> was the fastest draw! **+300 coins**` });
  }

  if (id === "event_roll") {
    const msgId = interaction.message.id;
    const key = `roll_${msgId}`;
    if (!globalThis._eventParticipants.has(key)) globalThis._eventParticipants.set(key, new Map());
    const rolls = globalThis._eventParticipants.get(key);
    if (rolls.has(userId)) return interaction.reply({ content: `you already rolled a **${rolls.get(userId)}**, one roll per person`, flags: MessageFlags.Ephemeral });
    const roll = Math.floor(Math.random() * 100) + 1;
    rolls.set(userId, roll);
    // Check if 60 seconds passed since the event message was sent
    const msgTime = interaction.message.createdTimestamp;
    const elapsed = Date.now() - msgTime;
    if (elapsed > 60_000) {
      // Time's up — find the winner
      let best = { userId: null, roll: 0 };
      for (const [uid, r] of rolls) {
        if (r > best.roll) best = { userId: uid, roll: r };
      }
      if (best.userId) {
        await db.updateBalance(best.userId, 500, "event_reward", "everyone_roll");
        await interaction.update({ components: [] });
        return interaction.followUp({ content: `🎲 <@${userId}> rolled **${roll}**!\n\n🏆 **<@${best.userId}> wins with a ${best.roll}!** +500 coins` });
      }
    }
    return interaction.reply({ content: `🎲 <@${userId}> rolled **${roll}**!` });
  }

  if (id === "event_donate_50") {
    const { getActiveModifier } = await import("../ai/randomEvents.js");
    const raid = getActiveModifier("pirate_raid");
    if (!raid) return interaction.reply({ content: "the pirate raid is over", flags: MessageFlags.Ephemeral });
    const econ = await db.getBalance(userId);
    if (econ.balance < 50) return interaction.reply({ content: "you can't afford to donate", flags: MessageFlags.Ephemeral });
    // Track donations per user for this raid
    if (!raid._donors) raid._donors = new Set();
    if (raid._donors.has(userId)) return interaction.reply({ content: "you already donated to this raid", flags: MessageFlags.Ephemeral });
    raid._donors.add(userId);
    await db.updateBalance(userId, -50, "event_donation", "pirate_raid");
    raid.donated = (raid.donated || 0) + 50;
    if (raid.donated >= raid.target) {
      await interaction.update({ components: [] });
      return interaction.followUp({ content: `🏴‍☠️ The pirates have been paid off! **${raid.donated}/${raid.target}** coins donated. The server is safe!` });
    }
    return interaction.reply({ content: `donated 50 coins! (${raid.donated}/${raid.target})`, flags: MessageFlags.Ephemeral });
  }

  // ── Tutorial navigation ────────────────────────────────────────────────
  if (id.startsWith("tutorial_")) {
    const parts = id.split("_");
    const currentStep = parseInt(parts[1]);
    const direction = parts[2];

    if (direction === "done" || direction === "skip") {
      return interaction.update({ content: "tutorial complete! just talk to me naturally or use /commands 💜", embeds: [], components: [] });
    }

    const { STEPS, buildStep } = await import("../commands/utility/tutorial.js");
    let newStep;
    if (direction === "back") newStep = Math.max(0, currentStep - 1);
    else if (direction === "next") newStep = Math.min(STEPS.length - 1, currentStep + 1);
    else newStep = currentStep;

    const response = buildStep(STEPS[newStep], newStep);
    return interaction.update(response);
  }

  // ── Poker table buttons ──────────────────────────────────────────────────
  if (id.startsWith("poker:")) {
    const [, action, channelId] = id.split(":");
    const { joinTable, getHoleCards, buildLobbyEmbed, getTable } = await import("../ai/poker.js");

    if (action === "join") {
      const result = await joinTable({ channelId, userId });
      if (!result.ok) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      }
      // Re-render the lobby embed with the new player count
      const { embed, row } = buildLobbyEmbed(result.table);
      try { await interaction.update({ embeds: [embed], components: [row] }); }
      catch { await interaction.reply({ content: `joined! pot: ${result.table.pot}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    if (action === "view") {
      const table = getTable(channelId);
      if (!table) return interaction.reply({ content: "no poker table here", flags: MessageFlags.Ephemeral });
      if (table.status !== "resolved") {
        return interaction.reply({ content: "hole cards aren't dealt yet — wait for the lobby to close", flags: MessageFlags.Ephemeral });
      }
      const hole = getHoleCards(channelId, userId);
      if (!hole) return interaction.reply({ content: "you weren't at the table", flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: `your hole cards: **${hole.hole.map((c) => `${c.rank}${c.suit}`).join("  ")}**`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // ── Activity Rare Event Buttons ─────────────────────────────────────────
  if (id.startsWith("activity_event_")) {
    const parts = id.split("_"); // activity_event_dig_cave_enter_userId
    const eventUserId = parts[parts.length - 1];
    if (userId !== eventUserId) return interaction.reply({ content: "this event isn't for you", flags: MessageFlags.Ephemeral });

    const eventKey = `activity:${interaction.message?.id || id}:${userId}`;
    if (_claimedActivityEvents.has(eventKey)) {
      return interaction.reply({ content: "you already claimed this event", flags: MessageFlags.Ephemeral });
    }
    _claimedActivityEvents.add(eventKey);
    setTimeout(() => _claimedActivityEvents.delete(eventKey), 30 * 60 * 1000).unref?.();

    const activity = parts[2]; // dig, fish, hunt
    const eventType = parts[3]; // cave, giant, nest
    const choice = parts[4]; // enter/leave, reel/cut, fight/retreat

    let result = "";
    let coins = 0;

    if (activity === "dig" && eventType === "cave") {
      if (choice === "enter") {
        if (Math.random() < 0.65) {
          coins = 300 + Math.floor(Math.random() * 201); // 300-500
          result = `🕳️ You ventured deep into the cave and found a **treasure hoard**! +**${coins}** coins!`;
        } else {
          coins = -50;
          result = "🕳️ The cave collapsed! You barely escaped and lost **50** coins in the process.";
        }
      } else {
        coins = 25;
        result = "🚶 You walked away cautiously. Found **25** coins near the entrance.";
      }
    } else if (activity === "fish" && eventType === "giant") {
      if (choice === "reel") {
        if (Math.random() < 0.55) {
          coins = 200 + Math.floor(Math.random() * 201); // 200-400
          result = `💪 After an epic struggle, you caught a **GIANT SEA SERPENT**! +**${coins}** coins!`;
        } else {
          coins = -30;
          result = "💥 The line snapped! The beast escaped and your rod needs repairs. Lost **30** coins.";
        }
      } else {
        coins = 15;
        result = "✂️ You cut the line. Smart — but a small fish got tangled. +**15** coins.";
      }
    } else if (activity === "hunt" && eventType === "nest") {
      if (choice === "fight") {
        const pet = await db.getPetBattleStats(userId);
        const petBonus = pet ? 0.2 : 0; // 20% better odds with a pet
        if (Math.random() < 0.5 + petBonus) {
          coins = 300 + Math.floor(Math.random() * 301); // 300-600
          result = `⚔️ You defeated the dragon and looted the nest! +**${coins}** coins!${pet ? ` (${pet.name} helped!)` : ""}`;
        } else {
          coins = -75;
          result = "🔥 The dragon breathed fire! You fled with burns. Lost **75** coins.";
        }
      } else {
        coins = 20;
        result = "🏃 You retreated safely. Found **20** coins dropped by a fleeing goblin.";
      }
    }

    if (coins !== 0) {
      await db.updateBalance(userId, coins, `${activity}_event`, `${eventType}_${choice}`);
    }

    // Remove the event buttons
    const { EmbedBuilder } = await import("discord.js");
    const color = coins > 0 ? 0x10B981 : coins < 0 ? 0xEF4444 : 0x2b2d31;
    const eventEmbed = new EmbedBuilder().setColor(color).setTitle("⚡ Event Result").setDescription(result).setTimestamp();
    return interaction.update({ embeds: [eventEmbed], components: [] });
  }

  // ── Bump reminder quick actions ─────────────────────────────────────────
  if (id.startsWith("bump_snooze_") || id.startsWith("bump_mute_tonight_")) {
    // Admin-only — snooze/mute aren't things random members should trigger.
    const hasPerm = interaction.memberPermissions?.has?.("ManageGuild")
      || interaction.memberPermissions?.has?.("Administrator")
      || interaction.user.id === (await import("../config.js")).default.ownerId;
    if (!hasPerm) {
      return interaction.reply({ content: "manage-server permission required", flags: MessageFlags.Ephemeral });
    }

    const { snoozeReminder, muteTonight } = await import("../ai/bumpReminder.js");

    if (id.startsWith("bump_snooze_")) {
      // bump_snooze_<minutes>_<serviceKey>
      const parts = id.split("_");
      const minutes = parseInt(parts[2], 10) || 15;
      const serviceKey = parts.slice(3).join("_") || "disboard";
      const newAt = snoozeReminder(interaction.guild.id, serviceKey, minutes, interaction.client);
      const ts = Math.floor(newAt / 1000);
      return interaction.reply({ content: `snoozed ${minutes}m — next ping <t:${ts}:R>`, flags: MessageFlags.Ephemeral });
    }

    if (id.startsWith("bump_mute_tonight_")) {
      const quiet = muteTonight(interaction.guild.id);
      return interaction.reply({
        content: `quiet hours set from ${quiet.start}:00 → ${quiet.end}:00 (${quiet.tz}). no pings until morning.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Unknown button
  return interaction.reply({ content: "i don't know what that button does", flags: MessageFlags.Ephemeral });
}

// ── Duel Move Resolution Helper ─────────────────────────────────────────────

async function resolveDuelMoves(interaction, duelKey) {
  const pending = globalThis._pendingDuelMoves.get(duelKey);
  if (!pending) return;
  globalThis._pendingDuelMoves.delete(duelKey);

  const { duelResultEmbedAnimated } = await import("../ai/gameVisuals.js");
  const move1 = pending.moves[pending.challengerId];
  const move2 = pending.moves[pending.targetId];

  // RPS matrix: attack > feint, feint > defend, defend > attack
  const beats = { attack: "feint", feint: "defend", defend: "attack" };
  let winnerId, loserId;

  if (move1 === move2) {
    // Tie — random winner
    winnerId = Math.random() < 0.5 ? pending.challengerId : pending.targetId;
    loserId = winnerId === pending.challengerId ? pending.targetId : pending.challengerId;
  } else if (beats[move1] === move2) {
    winnerId = pending.challengerId;
    loserId = pending.targetId;
  } else {
    winnerId = pending.targetId;
    loserId = pending.challengerId;
  }

  // Apply pet stat bonuses if both have pets
  let bonusNote = "";
  const pet1 = await db.getPetBattleStats(pending.challengerId);
  const pet2 = await db.getPetBattleStats(pending.targetId);
  if (pet1 && pet2) {
    bonusNote = `\n🐾 Pet bonuses applied!`;
  }

  if (pending.stake > 0) {
    const transfer = await db.transferBalance(loserId, winnerId, pending.stake, 0, "duel_loss", `duel:${move1}v${move2}`);
    if (!transfer.ok) {
      const payload = { content: `duel settlement failed: ${transfer.reason}`, flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  }
  await db.recordGameResult(winnerId, "duel", true, pending.stake || 0, pending.stake || 0);
  await db.recordGameResult(loserId, "duel", false, pending.stake || 0, 0);

  const guild = interaction.guild;
  const winnerName = guild?.members.cache.get(winnerId)?.displayName || "Winner";
  const loserName = guild?.members.cache.get(loserId)?.displayName || "Loser";
  const winnerMove = pending.moves[winnerId];
  const loserMove = pending.moves[loserId];

  const moveEmoji = { attack: "⚔️", defend: "🛡️", feint: "💨" };
  const newBal = (await db.getBalance(winnerId)).balance;
  const { embed, row } = duelResultEmbedAnimated(winnerName, loserName, pending.stake, newBal);
  embed.setDescription(`${embed.data.description}\n\n${moveEmoji[winnerMove]} **${winnerMove}** beats ${moveEmoji[loserMove]} **${loserMove}**${move1 === move2 ? " (tie broken by fate)" : ""}${bonusNote}`);

  try {
    await interaction.editReply({ embeds: [embed], components: row ? [row] : [] });
  } catch {
    // If editReply fails (e.g. interaction expired), try channel send
    try { await interaction.channel.send({ embeds: [embed], components: row ? [row] : [] }); } catch (e) { log(`[INTERACT] ${e.message}`); }
  }
}

// ── Select Menu Handler ─────────────────────────────────────────────────────

async function handleSelectMenu(interaction) {
  const id = interaction.customId;
  const userId = interaction.user.id;

  // ── Shop category navigation ──────────────────────────────────────────
  if (id === "shop_nav") {
    const value = interaction.values[0];
    const { buildOverviewEmbed, buildCategoryEmbed, buildCategorySelect, buildCategoryComponents } = await import("../commands/economy/shop.js");

    const [wallet, inv, pet] = await Promise.all([db.getBalance(userId), db.getInventory(userId), db.getPet(userId)]);
    const userItems = new Set((inv || []).map(i => i.item_name));
    const hasPet = !!pet;

    if (value === "_overview") {
      const embed = buildOverviewEmbed(wallet.balance);
      return interaction.update({ embeds: [embed], components: [buildCategorySelect()] });
    }

    const result = buildCategoryEmbed(value, 0, wallet.balance, userItems, hasPet);
    if (!result) return interaction.reply({ content: "empty category", flags: MessageFlags.Ephemeral });
    return interaction.update({ embeds: [result.embed], components: buildCategoryComponents(value, 0, result.items, result.totalPages, userItems, hasPet) });
  }

  // ── Shop item purchase ────────────────────────────────────────────────
  if (id.startsWith("shop_item_")) {
    const parts = id.split("_"); // shop_item_catkey_page
    const catKey = parts[2];
    const page = parseInt(parts[3]) || 0;
    const safeItemId = interaction.values[0];

    const { getItemsForCategory, buildCategoryEmbed, buildCategoryComponents, UNIQUE_TYPES, checkRequirement, isItemBuyable } = await import("../commands/economy/shop.js");
    const { openMysteryBox } = await import("../ai/economy.js");
    const { EmbedBuilder } = await import("discord.js");

    const allItems = getItemsForCategory(catKey);
    const item = allItems.find(i => i.name.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 40) === safeItemId);
    if (!item) return interaction.reply({ content: "item not found", flags: MessageFlags.Ephemeral });

    // Fetch user state
    const [wallet, inv, pet] = await Promise.all([db.getBalance(userId), db.getInventory(userId), db.getPet(userId)]);
    const userItems = new Set((inv || []).map(i => i.item_name));
    const hasPet = !!pet;

    // Helper to refresh the shop after any action
    const refreshShop = async (newBal) => {
      const freshInv = await db.getInventory(userId);
      const freshItems = new Set((freshInv || []).map(i => i.item_name));
      const updated = buildCategoryEmbed(catKey, page, newBal, freshItems, !!await db.getPet(userId));
      if (updated) await interaction.update({ embeds: [updated.embed], components: buildCategoryComponents(catKey, page, updated.items, updated.totalPages, freshItems, hasPet) });
    };

    // Check: already own this unique item?
    if (UNIQUE_TYPES.has(item.type) && userItems.has(item.name)) {
      return interaction.reply({ content: `❌ You already own **${item.name}**`, flags: MessageFlags.Ephemeral });
    }

    // Check: missing prerequisite?
    if (item.requires && !checkRequirement(item.requires, userItems, hasPet)) {
      const need = item.requires === "pet" ? "a pet (use `/pet adopt`)" : `**${item.requires}**`;
      return interaction.reply({ content: `🔒 You need ${need} before buying **${item.name}**`, flags: MessageFlags.Ephemeral });
    }

    // Atomic balance check + deduct — inside a single lock so two rapid
    // clicks can't both pass the "have enough" check before either debit
    // lands, letting the user walk away with 2 items for the price of 1.
    const deduct = await db.tryDeductBalance(userId, item.price, "shop_purchase", item.name);
    if (!deduct.ok) {
      if (deduct.reason === "insufficient") {
        return interaction.reply({ content: `❌ **${item.name}** costs **${item.price.toLocaleString()}** coins — you have **${deduct.balance.toLocaleString()}**`, flags: MessageFlags.Ephemeral });
      }
      if (deduct.reason === "economy_unavailable") {
        return interaction.reply({ content: "economy is offline rn, try again later", flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `❌ purchase failed: ${deduct.reason}`, flags: MessageFlags.Ephemeral });
    }

    // ── Mystery / Loot boxes ──
    if (item.type === "mystery") {
      const result = openMysteryBox();
      await db.updateBalance(userId, result.coins, "mystery_box", result.label);
      const newBal = (await db.getBalance(userId)).balance;
      const boxEmbed = new EmbedBuilder()
        .setColor(result.coins >= 500 ? 0xFFD700 : result.coins >= 100 ? 0x10B981 : 0x6B7280)
        .setDescription(`${item.emoji || "📦"} **${item.name}** → ${result.label}\nNet: **${result.coins - item.price >= 0 ? "+" : ""}${result.coins - item.price}** coins · 💰 ${newBal.toLocaleString()}`);
      await refreshShop(newBal);
      return interaction.followUp({ embeds: [boxEmbed] });
    }

    // ── Minions ──
    if (item.type === "minion" && item.minionType) {
      const { hireMinion } = await import("../ai/minions.js");
      const result = hireMinion(userId, item.minionType);
      if (!result.success) {
        await db.updateBalance(userId, item.price, "refund", item.name);
        return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
      }
      const newBal = (await db.getBalance(userId)).balance;
      await refreshShop(newBal);
      return interaction.followUp({ content: `${item.emoji || "🤖"} Hired **${item.name}**! · 💰 ${newBal.toLocaleString()}` });
    }

    if (item.type === "minion_slot") {
      const { upgradeSlots } = await import("../ai/minions.js");
      const result = upgradeSlots(userId);
      if (!result.success) {
        await db.updateBalance(userId, item.price, "refund", item.name);
        return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
      }
      const newBal = (await db.getBalance(userId)).balance;
      await refreshShop(newBal);
      return interaction.followUp({ content: `➕ Minion slot **${result.newMax}** unlocked! · 💰 ${newBal.toLocaleString()}` });
    }

    // ── Regular item ──
    await db.addToInventory(userId, item.name, item.type);
    await db.unlockAchievement(userId, "first_purchase");
    const newBal = (await db.getBalance(userId)).balance;
    await refreshShop(newBal);
    return interaction.followUp({ content: `${item.emoji || "🛒"} Bought **${item.name}** · -${item.price.toLocaleString()} · 💰 ${newBal.toLocaleString()}`, flags: MessageFlags.Ephemeral });
  }
}
