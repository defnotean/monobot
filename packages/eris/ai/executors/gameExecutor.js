// ─── Game Sub-Executor ──────────────────────────────────────────────────────
// Handles: trivia_start, trivia_answer, word_scramble_start, word_scramble_guess,
//          number_guess_start, number_guess_attempt, start_duel, accept_duel,
//          heist_start, heist_join, heist_execute, boss_spawn, boss_attack, boss_status
// Called from main executor.js via delegation.

import * as db from "../../database.js";
import { resolveMember } from "../../utils/discord.js";

const HANDLED = new Set([
  "trivia_start", "trivia_answer", "word_scramble_start", "word_scramble_guess",
  "number_guess_start", "number_guess_attempt", "start_duel", "accept_duel",
  "heist_start", "heist_join", "heist_execute", "boss_spawn", "boss_attack", "boss_status",
]);

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "trivia_start": {
      const existing = db.getActiveGame(message.channel.id, message.author.id, "trivia");
      if (existing) return "you already have an active trivia question \u2014 answer it first (A, B, C, or D)";
      const { TRIVIA_CATEGORIES } = await import("../gambling.js");
      const category = TRIVIA_CATEGORIES[(input.category || "general").toLowerCase()] || 9;
      const difficulty = ["easy", "medium", "hard"].includes(input.difficulty) ? input.difficulty : "medium";
      // Clamp to non-negative — a negative stake would mean "bet -100", then
      // win → updateBalance(-100) → user LOSES coins on a winning round.
      // Also caps at 1M to match the global parseBet contract.
      const rawStake = Number(input.stake);
      const stake = Number.isFinite(rawStake) ? Math.min(1_000_000, Math.max(0, Math.floor(rawStake))) : 0;
      if (stake > 0) {
        const econ = await db.getBalance(message.author.id);
        if (econ.balance < stake) return `you only have ${econ.balance} coins`;
      }
      try {
        const res = await fetch(`https://opentdb.com/api.php?amount=1&category=${category}&difficulty=${difficulty}&type=multiple`);
        const data = await res.json();
        if (!data.results?.length) return "couldn't fetch a trivia question, try again";
        const q = data.results[0];
        const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&eacute;/g, "e").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"');
        const answers = [...q.incorrect_answers.map(decode), decode(q.correct_answer)].sort(() => Math.random() - 0.5);
        const correctIndex = answers.indexOf(decode(q.correct_answer));
        const labels = ["A", "B", "C", "D"];
        db.saveActiveGame(message.channel.id, message.author.id, "trivia", { question: decode(q.question), answers, correctIndex, difficulty }, stake);
        const { triviaQuestionEmbed } = await import("../gameVisuals.js");
        const { embed: triviaEmbed, row: triviaRow } = triviaQuestionEmbed(decode(q.question), answers, difficulty, stake);
        await message.channel.send({ embeds: [triviaEmbed], components: [triviaRow] });
        return "answer with A, B, C, or D \u2014 or just tap a button";
      } catch (e) {
        return `trivia api error: ${e.message}`;
      }
    }

    case "trivia_answer": {
      const game = db.getActiveGame(message.channel.id, message.author.id, "trivia");
      if (!game) return "no active trivia question \u2014 start one first";
      const answer = (input.answer || "").toUpperCase().trim();
      const labels = ["A", "B", "C", "D"];
      const idx = labels.indexOf(answer);
      if (idx === -1) return "answer with A, B, C, or D";
      db.deleteActiveGame(message.channel.id, message.author.id, "trivia");
      const correct = idx === game.gameState.correctIndex;
      const correctAnswer = game.gameState.answers[game.gameState.correctIndex];
      await db.recordTriviaResult(message.author.id, correct);
      let payout = 0;
      if (game.stake > 0) {
        const multiplier = game.gameState.difficulty === "hard" ? 3 : game.gameState.difficulty === "medium" ? 2 : 1.5;
        payout = correct ? Math.floor(game.stake * (multiplier - 1)) : -game.stake;
        await db.updateBalance(message.author.id, payout, correct ? "gamble_win" : "gamble_loss", `trivia:${correct}`);
      }
      const stats = await db.getTriviaStats(message.author.id);
      const { triviaResultEmbed } = await import("../gameVisuals.js");
      await message.channel.send({ embeds: [triviaResultEmbed(correct, game.gameState.question, correctAnswer, answer, stats, payout)] });
      return correct ? "nice one" : "better luck next time";
    }

    case "word_scramble_start": {
      const existing = db.getActiveGame(message.channel.id, message.author.id, "word_scramble");
      if (existing) return `you already have an active word scramble \u2014 the scrambled word is: **${existing.gameState.scrambled}**`;
      const { pickRandomWord, scrambleWord } = await import("../gambling.js");
      const word = pickRandomWord();
      const scrambled = scrambleWord(word);
      // Clamp to non-negative — a negative stake would mean "bet -100", then
      // win → updateBalance(-100) → user LOSES coins on a winning round.
      // Also caps at 1M to match the global parseBet contract.
      const rawStake = Number(input.stake);
      const stake = Number.isFinite(rawStake) ? Math.min(1_000_000, Math.max(0, Math.floor(rawStake))) : 0;
      if (stake > 0) {
        const econ = await db.getBalance(message.author.id);
        if (econ.balance < stake) return `you only have ${econ.balance} coins`;
      }
      db.saveActiveGame(message.channel.id, message.author.id, "word_scramble", { word, scrambled, attempts: 0 }, stake);
      const { wordScrambleEmbed } = await import("../gameVisuals.js");
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
      const wsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("scramble_hint").setLabel("Hint (shows first letter)").setEmoji("\u{1F4A1}").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("scramble_giveup").setLabel("Give Up").setEmoji("\u{1F3F3}\uFE0F").setStyle(ButtonStyle.Danger),
      );
      await message.channel.send({ embeds: [wordScrambleEmbed(scrambled, word.length, stake)], components: [wsRow] });
      return "[game started]";
    }

    case "word_scramble_guess": {
      const game = db.getActiveGame(message.channel.id, message.author.id, "word_scramble");
      if (!game) return "no active word scramble \u2014 start one first";
      const guess = (input.guess || "").toLowerCase().trim();
      game.gameState.attempts++;
      if (guess === game.gameState.word) {
        db.deleteActiveGame(message.channel.id, message.author.id, "word_scramble");
        if (game.stake > 0) {
          await db.updateBalance(message.author.id, game.stake, "gamble_win", "word_scramble");
          await db.recordGameResult(message.author.id, "word_scramble", true, game.stake, game.stake * 2);
        }
        const { wordScrambleResultEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [wordScrambleResultEmbed(true, game.gameState.word, game.gameState.attempts, game.stake)] });
        return "[game started]";
      }
      if (game.gameState.attempts >= 5) {
        db.deleteActiveGame(message.channel.id, message.author.id, "word_scramble");
        if (game.stake > 0) {
          await db.updateBalance(message.author.id, -game.stake, "gamble_loss", "word_scramble");
          await db.recordGameResult(message.author.id, "word_scramble", false, game.stake, 0);
        }
        const { wordScrambleResultEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [wordScrambleResultEmbed(false, game.gameState.word, game.gameState.attempts, game.stake)] });
        return "[game started]";
      }
      db.saveActiveGame(message.channel.id, message.author.id, "word_scramble", game.gameState, game.stake);
      const hint = game.gameState.word[0];
      const { wordScrambleHintEmbed } = await import("../gameVisuals.js");
      await message.channel.send({ embeds: [wordScrambleHintEmbed(game.gameState.scrambled, hint, 5 - game.gameState.attempts)] });
      return "try again";
    }

    case "number_guess_start": {
      const existing = db.getActiveGame(message.channel.id, message.author.id, "number_guess");
      if (existing) return `you already have an active number game \u2014 guess a number between 1 and ${existing.gameState.max}`;
      const max = Math.min(Math.max(Math.floor(input.max_number || 100), 10), 1000);
      // Clamp to non-negative — a negative stake would mean "bet -100", then
      // win → updateBalance(-100) → user LOSES coins on a winning round.
      // Also caps at 1M to match the global parseBet contract.
      const rawStake = Number(input.stake);
      const stake = Number.isFinite(rawStake) ? Math.min(1_000_000, Math.max(0, Math.floor(rawStake))) : 0;
      if (stake > 0) {
        const econ = await db.getBalance(message.author.id);
        if (econ.balance < stake) return `you only have ${econ.balance} coins`;
      }
      const secret = Math.floor(Math.random() * max) + 1;
      db.saveActiveGame(message.channel.id, message.author.id, "number_guess", { secret, max, attempts: 0, maxAttempts: 7 }, stake);
      const { numberGuessStartEmbed } = await import("../gameVisuals.js");
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
      const ngRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("numguess_giveup").setLabel("Give Up").setEmoji("\u{1F3F3}\uFE0F").setStyle(ButtonStyle.Danger),
      );
      await message.channel.send({ embeds: [numberGuessStartEmbed(max, stake)], components: [ngRow] });
      return "[game started]";
    }

    case "number_guess_attempt": {
      const game = db.getActiveGame(message.channel.id, message.author.id, "number_guess");
      if (!game) return "no active number game \u2014 start one first";
      const guess = Math.floor(input.guess || 0);
      game.gameState.attempts++;
      if (guess === game.gameState.secret) {
        db.deleteActiveGame(message.channel.id, message.author.id, "number_guess");
        if (game.stake > 0) await db.updateBalance(message.author.id, game.stake, "gamble_win", "number_guess");
        const { numberGuessResultEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [numberGuessResultEmbed(true, game.gameState.secret, game.gameState.attempts, game.stake)] });
        return "you got it";
      }
      if (game.gameState.attempts >= game.gameState.maxAttempts) {
        db.deleteActiveGame(message.channel.id, message.author.id, "number_guess");
        if (game.stake > 0) await db.updateBalance(message.author.id, -game.stake, "gamble_loss", "number_guess");
        const { numberGuessResultEmbed } = await import("../gameVisuals.js");
        await message.channel.send({ embeds: [numberGuessResultEmbed(false, game.gameState.secret, game.gameState.attempts, game.stake)] });
        return "out of guesses";
      }
      const hintDir = guess < game.gameState.secret ? "higher" : "lower";
      db.saveActiveGame(message.channel.id, message.author.id, "number_guess", game.gameState, game.stake);
      const { numberGuessHintEmbed } = await import("../gameVisuals.js");
      await message.channel.send({ embeds: [numberGuessHintEmbed(hintDir, game.gameState.maxAttempts - game.gameState.attempts, game.gameState.max)] });
      return `${hintDir}`;
    }

    case "start_duel": {
      const targetName = input.target;
      if (!targetName) return "who do you want to duel?";
      const guild = message.guild;
      if (!guild) return "duels only work in servers";
      const target = await resolveMember(guild, targetName);
      if (!target) return `couldn't find user "${targetName}"`;
      if (target.id === message.author.id) return "you can't duel yourself weirdo";
      const stake = Math.floor(input.stake || 0);
      if (stake > 0) {
        const challenger = await db.getBalance(message.author.id);
        if (challenger.balance < stake) return `you only have ${challenger.balance} coins, can't stake ${stake}`;
        const targetBal = await db.getBalance(target.id);
        if (targetBal.balance < stake) return `${target.displayName} only has ${targetBal.balance} coins, they can't match your ${stake} stake`;
      }
      const result = db.createDuel(message.author.id, target.id, message.channel.id, stake);
      if (!result.success) return result.error;
      const { duelChallengeEmbed } = await import("../gameVisuals.js");
      const { embed: duelEmbed, row: duelRow } = duelChallengeEmbed(message.author.displayName, target.displayName, target.id, stake);
      await message.channel.send({ embeds: [duelEmbed], components: [duelRow] });
      return "[game started]";
    }

    case "accept_duel": {
      const duel = db.getPendingDuel(message.channel.id, message.author.id);
      if (!duel) return "you don't have any pending duel challenges in this channel";
      const resolved = db.resolveDuel(message.channel.id, message.author.id);
      if (!resolved) return "duel not found or expired";
      const { randomQuip } = await import("../gambling.js");
      const { duelResultEmbed } = await import("../gameVisuals.js");
      const challengerWins = Math.random() < 0.5;
      const winnerId = challengerWins ? resolved.challengerId : resolved.targetId;
      const loserId = challengerWins ? resolved.targetId : resolved.challengerId;
      if (resolved.stake > 0) {
        // Atomic stake transfer: move the stake from loser to winner in one
        // locked operation instead of a credit-then-debit pair (which could
        // mint coins if the loser's debit failed after the winner was paid).
        const transfer = await db.transferBalance(loserId, winnerId, resolved.stake, 0, "duel_loss", `duel`);
        if (!transfer.ok) return `duel couldn't settle because the loser couldn't pay: ${transfer.reason}`;
      }
      const guild = message.guild;
      const winnerName = guild?.members.cache.get(winnerId)?.displayName || "Winner";
      const loserName = guild?.members.cache.get(loserId)?.displayName || "Loser";
      // Animated duel countdown
      const { duelCountdownFrames, duelResultEmbedAnimated, animateEmbed } = await import("../gameVisuals.js");
      const challengerName = guild?.members.cache.get(resolved.challengerId)?.displayName || "Challenger";
      const targetName2 = guild?.members.cache.get(resolved.targetId)?.displayName || "Target";
      const countdown = duelCountdownFrames(challengerName, targetName2);
      const winnerBal = await db.getBalance(winnerId);
      const { embed: dResultE, row: dResultR } = duelResultEmbedAnimated(winnerName, loserName, resolved.stake, winnerBal.balance);
      countdown.push({ embed: dResultE, components: [dResultR] });
      await animateEmbed(message.channel, countdown, 800);
      return "[game started]";
    }

    case "heist_start": {
      if (!message.guild) return "heists only work in servers";
      const existing = await db.getActiveHeist(message.guild.id);
      if (existing) return "there's already a heist recruiting \u2014 join it instead";
      const lb = await db.getLeaderboard(1);
      if (!lb.length) return "nobody has any coins to heist";
      const targetId = lb[0].user_id;
      if (targetId === message.author.id) return "you're the richest person \u2014 they'd be heisting YOU";
      const heist = await db.createHeist(message.guild.id, message.channel.id, message.author.id, targetId);
      if (!heist) return "couldn't create heist";
      const { randomQuip } = await import("../gambling.js");
      return `heist organized targeting <@${targetId}> (${lb[0].balance} coins)! need 3+ people \u2014 say "join heist" to participate. ${await randomQuip()}`;
    }

    case "heist_join": {
      if (!message.guild) return "heists only work in servers";
      const heist = await db.getActiveHeist(message.guild.id);
      if (!heist) return "no active heist to join \u2014 start one first";
      if ((heist.participants || []).includes(message.author.id)) return "you're already in the heist";
      await db.joinHeist(heist.id, message.author.id);
      const count = (heist.participants || []).length + 1;
      return `you're in! ${count} people in the heist now${count >= 3 ? " \u2014 ready to execute!" : ` (need ${3 - count} more)`}`;
    }

    case "heist_execute": {
      if (!message.guild) return "heists only work in servers";
      const heist = await db.getActiveHeist(message.guild.id);
      if (!heist) return "no active heist";
      const parts = heist.participants || [];
      if (parts.length < 3) return `need ${3 - parts.length} more people before executing`;
      const claimed = await db.claimHeistExecution(heist.id);
      if (!claimed) return "that heist is already being executed";
      const successRate = Math.min(0.4 + (parts.length - 3) * 0.15, 0.85);
      const success = Math.random() < successRate;
      const targetBal = await db.getBalance(heist.target_user_id);
      if (targetBal.balance < 50) {
        await db.resolveHeist(heist.id, "failed", 0);
        return "heist called off \u2014 target only has ${targetBal.balance} coins, not worth the risk";
      }
      if (success) {
        const { randomQuip } = await import("../gambling.js");
        const intended = Math.floor(targetBal.balance * (0.2 + Math.random() * 0.2));
        // Debit the victim FIRST, atomically, for what they actually hold (clamp
        // to their balance so a mid-flight drain can't make us steal more than
        // exists). Only what's actually taken is distributed — coins are
        // conserved. If the debit fails (victim drained below the amount), the
        // heist resolves as failed and nobody is paid.
        const debit = await db.tryDeductBalance(heist.target_user_id, intended, "heist_victim", "heisted");
        if (!debit.ok) {
          await db.resolveHeist(heist.id, "failed", 0);
          return `heist fell apart — the target's vault was empty by the time you cracked it. nobody got paid`;
        }
        const stolen = intended;
        const share = Math.floor(stolen / parts.length);
        // Pay each participant their share of the ALREADY-TAKEN loot.
        await Promise.all(parts.map(p => db.updateBalance(p, share, "heist_win", "heist")));
        await db.resolveHeist(heist.id, "complete", stolen);
        return `HEIST SUCCESS! stole ${stolen} coins from <@${heist.target_user_id}>. each participant gets ${share} coins! ${await randomQuip()}`;
      }
      const fine = 50;
      await Promise.all(parts.map(p => db.updateBalance(p, -fine, "heist_fail", "caught")));
      await db.resolveHeist(heist.id, "failed", 0);
      return `HEIST FAILED! everyone got caught and fined ${fine} coins each. better luck next time criminals`;
    }

    case "boss_spawn": {
      if (!message.guild) return "boss battles only work in servers";
      const existing = await db.getActiveBoss(message.guild.id);
      if (existing) return `there's already an active boss: ${existing.boss_name} (${existing.boss_hp}/${existing.max_hp} HP)`;
      const { getRandomBoss } = await import("../stocks.js");
      const boss = getRandomBoss();
      const debit = await db.tryDeductBalance(message.author.id, 500, "boss_spawn", boss.name);
      if (!debit.ok) {
        if (debit.reason === "insufficient") return "spawning a boss costs 500 coins";
        return `couldn't spawn boss: ${debit.reason}`;
      }
      const expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();
      const created = await db.createBossBattle(message.guild.id, `${boss.emoji} ${boss.name}`, boss.hp, expiresAt);
      if (!created) {
        await db.updateBalance(message.author.id, 500, "boss_spawn_refund", boss.name).catch(() => {});
        return "couldn't spawn boss";
      }
      return `**${boss.emoji} ${boss.name}** has appeared! HP: ${boss.hp} \u2014 attack it to deal damage (costs 10 coins per attack). defeats in 2 hours or it despawns!`;
    }

    case "boss_attack": {
      if (!message.guild) return "boss battles only work in servers";
      const boss = await db.getActiveBoss(message.guild.id);
      if (!boss) return "no active boss \u2014 spawn one first";
      const debit = await db.tryDeductBalance(message.author.id, 10, "boss_attack", boss.boss_name);
      if (!debit.ok) {
        if (debit.reason === "insufficient") return "attacks cost 10 coins and you're broke";
        return `boss attack failed: ${debit.reason}`;
      }
      const { calculateDamage } = await import("../stocks.js");
      const damage = calculateDamage();
      const result = await db.damageBoss(boss.id, message.author.id, damage);
      if (!result) {
        await db.updateBalance(message.author.id, 10, "boss_attack_refund", boss.boss_name).catch(() => {});
        return "boss attack failed";
      }
      if (result.alreadyDead) {
        await db.updateBalance(message.author.id, 10, "boss_attack_refund", boss.boss_name).catch(() => {});
        return "the boss is already dead! someone else got the killing blow";
      }
      if (result.defeated) {
        const loot = Math.floor(boss.max_hp * 0.1);
        const participants = Object.entries(result.participants || {});
        const totalDamage = participants.reduce((s, [, d]) => s + d, 0);
        for (const [uid, dmg] of participants) {
          const share = Math.floor(loot * (dmg / totalDamage));
          await db.updateBalance(uid, share, "boss_loot", boss.boss_name);
        }
        return `**${boss.boss_name} DEFEATED!** \u{1F389} you dealt ${damage} damage for the killing blow! ${loot} coins distributed to all ${participants.length} participants!`;
      }
      return `dealt **${damage}** damage to ${boss.boss_name}! HP: ${result.boss_hp}/${boss.max_hp}${result.phase > boss.phase ? ` \u2014 PHASE ${result.phase}!` : ""}`;
    }

    case "boss_status": {
      if (!message.guild) return "boss battles only work in servers";
      const boss = await db.getActiveBoss(message.guild.id);
      if (!boss) return "no active boss right now";
      const participants = Object.entries(boss.participants || {});
      const topDamage = participants.sort((a, b) => b[1] - a[1]).slice(0, 5);
      const lines = topDamage.map(([uid, dmg], i) => `${i + 1}. <@${uid}> \u2014 ${dmg} damage`);
      return `**${boss.boss_name}** \u2014 HP: ${boss.boss_hp}/${boss.max_hp} (Phase ${boss.phase})\nTop damage:\n${lines.join("\n") || "no one has attacked yet"}`;
    }

    default:
      return undefined;
  }
}
