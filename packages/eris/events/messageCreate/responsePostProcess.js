// ─── packages/eris/events/messageCreate/responsePostProcess.js ──────────────
// Stage 6 — strip the LLM reply, enforce the per-turn char budget, send via
// the firewall gate + sendHumanReply, handle awaited-reply bookkeeping,
// detect sleep triggers in the reply, and schedule the 1% afterthought
// follow-up. The orchestrator hands us a ctx bag and we mutate `ctx.reply`,
// `ctx.replyDelivered`, `ctx.sentimentScore`.

import config from "../../config.js";
import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { trackHumanInteraction, detectMoment } from "../../ai/humanity.js";
import { quickSentiment } from "../../ai/sentiment.js";
import { sendHumanReply } from "@defnotean/shared/humanDelay";

import { scrubLeakedToolSyntax } from "./replyScrub.js";
import { triggerSleep } from "./sleepState.js";
import { rememberAwaitingReply, forgetAwaitingReply } from "./gates.js";
import { markBotResponded } from "./spamTracker.js";
import { SLEEP_TRIGGERS } from "./constants.js";
import { activeProviderNeedsGeminiClient, getConvClient } from "./geminiPool.js";

const GAME_TOOL_NAMES = new Set([
  "coinflip_bet", "dice_roll_bet", "slots_spin", "blackjack_start", "blackjack_action",
  "russian_roulette", "rps_play", "trivia_start", "scratch_card", "open_lootbox",
  "start_duel", "pet_battle", "boss_attack", "boss_spawn", "heist_start",
  "fish", "hunt", "dig", "work", "beg", "search_location",
  "adventure_start", "adventure_choice", "word_scramble_start", "number_guess_start",
  "send_gif", "create_meme",
]);

/**
 * Post-process the AI's response — clean it up, send it, and run the
 * downstream side effects that depend on the reply having been delivered.
 * Returns the data the persistence stage needs.
 *
 * @param {object} opts
 * @returns {Promise<{ sentimentScore: number, replyDelivered: boolean, gameEmbedSent: boolean, sendingSkipped: boolean, deliveredReply: string }>}
 */
export async function postProcessResponse({
  message,
  result,
  cleanMessage,
  displayName,
  charBudget,
  isDM,
  isTwinMsg,
  firewallGate,
  botName,
  clearTypingInterval,
}) {
  // ─── 6. RESPONSE RENDERING ──────────────────────────────────────────
  // Stop typing indicator
  clearTypingInterval();

  // Sentiment-based affinity — compute BEFORE sending so humanity tracking has it
  // quickSentiment now static import
  const sentimentScore = quickSentiment(cleanMessage);

  // Send response — suppress if a game embed was already sent to the channel
  const gameEmbedSent = !!result?.toolsUsed?.some(t => GAME_TOOL_NAMES.has(t));

  let replyDelivered = false;
  let deliveredReply = "";

  if (result?.text && gameEmbedSent) {
    // Game already sent a rich embed — skip the AI's redundant text description
    // Still save to history and do post-processing, just don't send the text
  } else if (result?.text) {
    let reply = scrubLeakedToolSyntax(result.text);
    // If reply is now empty after stripping leaked tool syntax, skip sending
    if (reply) {
      // Collapse double+ newlines to single (prevents big gaps in Discord)
      reply = reply.replace(/\n{2,}/g, "\n");
      // Resolve @username mentions in AI response to proper Discord <@id> pings
      if (message.guild) {
        reply = reply.replace(/@(\w+)/g, (match, name) => {
          const member = message.guild.members.cache.find(m => m.user.username.toLowerCase() === name.toLowerCase() || m.displayName.toLowerCase() === name.toLowerCase());
          return member ? `<@${member.id}>` : match;
        });
      }
      // Enforce per-turn character budget. Prompt directive alone keeps
      // drifting back to 400-600 char replies. Trim to the last complete
      // sentence at/under budget; 1.2x grace so a barely-over reply isn't cut.
      if (charBudget && reply.length > Math.floor(charBudget * 1.2)) {
        const before = reply.length;
        const slice = reply.slice(0, charBudget);
        const lastEnd = Math.max(
          slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "),
          slice.lastIndexOf(".\n"), slice.lastIndexOf("!\n"), slice.lastIndexOf("?\n"),
          slice.endsWith(".") || slice.endsWith("!") || slice.endsWith("?") ? slice.length - 1 : -1,
        );
        if (lastEnd > charBudget * 0.4) {
          reply = reply.slice(0, lastEnd + 1).trim();
        } else {
          const sp = slice.lastIndexOf(" ");
          reply = (sp > charBudget * 0.4 ? slice.slice(0, sp) : slice).trim();
        }
        log(`[LENGTH] Trimmed reply ${before} → ${reply.length} chars (budget ${charBudget})`);
      }

      if (reply.length > 2000) reply = reply.substring(0, 1997) + "...";

      if (!message.channel) return { sentimentScore, replyDelivered: false, gameEmbedSent, sendingSkipped: true, deliveredReply: "" }; // Channel deleted mid-processing

      // Human-timed delivery: realistic typing duration + occasional split
      // into 2-3 messages at natural breakpoints.
      // sendHumanReply now static import

      // Speculative-firewall gate: await verdict, send AI reply only if safe.
      if (isDM) {
        replyDelivered = await firewallGate(() => sendHumanReply(message, reply, { isDM: true }));
      } else {
        replyDelivered = await firewallGate(async () => {
          trackHumanInteraction(message.author.id, displayName, cleanMessage, sentimentScore, message.author.id === config.ownerId);
          detectMoment(message.author.id, cleanMessage, reply || "", sentimentScore);
          markBotResponded(message.guildId || "dm", message.author.id);
          await sendHumanReply(message, reply, { isDM: false });
          // If we asked a question, track this user for a follow-up without needing @mention
          if (!isTwinMsg) {
            if (reply.includes("?")) {
              rememberAwaitingReply(message.channel.id, message.author.id);
            } else {
              forgetAwaitingReply(message.channel.id);
            }
          }
        });
      }
      // If firewall blocked, skip post-reply work that depends on the reply being sent.
      if (!replyDelivered) { clearTypingInterval(); return { sentimentScore, replyDelivered: false, gameEmbedSent, sendingSkipped: true, deliveredReply: "" }; }

      await db.saveInteraction(message.client.user.id, botName, message.channel.id, reply, true);

      // Sleep detection — if user told her to sleep or she says she's going to sleep
      const userSaidSleep = SLEEP_TRIGGERS.test(cleanMessage);
      const botSaidSleep = SLEEP_TRIGGERS.test(reply);
      if ((userSaidSleep && botSaidSleep) || (botSaidSleep && new Date().getHours() >= 22)) {
        triggerSleep();
      }

      deliveredReply = reply;

      // Afterthought — sometimes send a short follow-up like a real person
      // 1% rate (was 4%) — saves Gemini quota while keeping the feature alive
      if (!isTwinMsg && reply.length > 80 && Math.random() < 0.01) {
        const afterDelay = 3000 + Math.floor(Math.random() * 4000);
        setTimeout(async () => {
          try {
            const convClient = getConvClient();
            if (!convClient || !activeProviderNeedsGeminiClient()) return;
            const afterResponse = await convClient.models.generateContent({
              model: config.geminiFastModel,
              contents: [{ role: "user", parts: [{ text: `you just said: "${reply.substring(0, 100)}". send a VERY short afterthought that adds NEW info — a correction, tangent, or "oh wait also". MAX 6 words. NEVER repeat any words from what you just said. examples: "actually wait nvm", "oh also check ur dms", "that came out wrong lol"` }] }],
              config: { systemInstruction: "you are eris. lowercase, casual, texting style. this is an afterthought, NOT a repeat.", maxOutputTokens: 30 },
            });
            const afterText = afterResponse.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
            // Strict dedup: reject if >40% of words overlap with original reply
            if (afterText && afterText.length > 2 && afterText.length < 60) {
              const afterWords = new Set(afterText.toLowerCase().split(/\s+/));
              const replyWords = new Set(reply.toLowerCase().split(/\s+/));
              const overlap = [...afterWords].filter(w => replyWords.has(w) && w.length > 2).length;
              if (overlap / afterWords.size < 0.4) {
                // Defensive: re-check firewall verdict (verdict is cached at this point).
                await firewallGate(() => message.channel.send(afterText));
              }
            }
          } catch (e) { log(`[MSG] ${e.message}`); }
        }, afterDelay);
      }
    } // end if (reply) — stripped-empty responses silently skipped
  }

  return { sentimentScore, replyDelivered, gameEmbedSent, sendingSkipped: false, deliveredReply };
}
