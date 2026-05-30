// ─── packages/eris/events/messageCreate/analytics.js ────────────────────────
// Stage 7 — everything that happens AFTER the reply has been sent (or
// suppressed): persist history, update relationship + mood, train the
// personality tracker, extract a long-term episode, award passive coins,
// detect inside jokes, and run the nap/sleep state machine plus auto-nap
// fallback. Behavior is unchanged from the inline code in messageCreate.js.

import config from "../../config.js";
import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { trackInteraction as trackPersonality } from "../../ai/personality.js";
import { analyzeExchange } from "../../ai/longmemory.js";

import { triggerSleep, isSleeping } from "./sleepState.js";
import { SLEEP_TRIGGERS, NAP_TRIGGERS } from "./constants.js";

const MAX_HISTORY_REPLY_CHARS = 1900;

export function appendModelReplyIfMissing(history, text) {
  if (!Array.isArray(history) || !text) return false;
  const storedText = String(text).slice(0, MAX_HISTORY_REPLY_CHARS);
  const last = history[history.length - 1];
  const lastText = last?.parts?.[0]?.text;
  if ((last?.role === "model" || last?.role === "assistant") && lastText === storedText) {
    return false;
  }
  history.push({ role: "model", parts: [{ text: storedText }] });
  return true;
}

/**
 * Run the post-reply analytics pass. Persists the conversation, updates
 * mood/affinity, trains personality tracker, records the inside-joke
 * counter, and runs the sleep/nap state machine.
 *
 * @param {object} opts
 */
export async function runAnalytics({
  message,
  result,
  cleanMessage,
  sentimentScore,
  isTwinMsg,
  isDM,
  gameEmbedSent,
  history,
  channelKey,
  conversations,
  firewallGate,
}) {
  // ─── 7. STATE PERSISTENCE ───────────────────────────────────────────
  // Update history — don't save suppressed game text (user never saw it)
  if (result?.text && !gameEmbedSent) {
    appendModelReplyIfMissing(history, result.text);
  } else if (gameEmbedSent && result?.toolsUsed?.length) {
    // For games, just note what happened — not the AI's narration
    // Don't add tool-usage notes to history — model echoes them as visible text
  }
  // Cap per-channel history at 40 entries to prevent unbounded growth
  if (history.length > 40) history.splice(0, history.length - 40);
  conversations.set(channelKey, history);

  // Creator boost — boss always maxes out affection
  const isCreator = message.author.id === config.ownerId;
  if (isCreator) {
    db.updateRelationship(message.author.id, 10, { isOwner: true, sentiment: 0.8, dampen: true }); // big affinity boost every message
    db.shiftMood(10, 10); // mood + energy — boss makes her happy and energized
  } else {
    const affinityDelta = sentimentScore > 0.3 ? 2 : sentimentScore < -0.3 ? -1 : 1;
    db.updateRelationship(message.author.id, affinityDelta, { sentiment: sentimentScore, dampen: true });
    const moodDelta = Math.round(sentimentScore * 3);
    db.shiftMood(moodDelta, 2);
  }

  // Personality learning — track interaction patterns
  try {
    // trackInteraction now static import (as trackPersonality)
    trackPersonality(message.author.id, message.guild?.id, cleanMessage, sentimentScore);
  } catch (e) { log(`[MSG] ${e.message}`); }

  // Long-term memory — extract episodes, update mood narrative
  // Inner thoughts are now captured LIVE from the model's actual reasoning tokens
  // in dual.js (thinkingParts) — no fake generation needed
  try {
    // analyzeExchange now static import
    analyzeExchange(message.author.id, message.channel.id, cleanMessage, result?.text || "", sentimentScore);
  } catch (e) { log(`[MSG] ${e.message}`); }

  // Per-message coin earning (passive income)
  await db.earnMessageCoins(message.author.id);

  // Inside joke tracking — detect recurring phrases
  if (cleanMessage.length > 5 && cleanMessage.length < 50 && !isTwinMsg) {
    const phrase = cleanMessage.toLowerCase().trim();
    if (!globalThis._phraseTracker) globalThis._phraseTracker = {};
    const pt = globalThis._phraseTracker;
    // Cleanup: cap at 500 phrases to prevent memory leak
    const ptKeys = Object.keys(pt);
    if (ptKeys.length > 500) {
      const sorted = ptKeys.sort((a, b) => pt[a].firstSeen - pt[b].firstSeen);
      sorted.slice(0, 200).forEach(k => delete pt[k]);
    }
    if (!pt[phrase]) pt[phrase] = { count: 0, users: new Set(), firstSeen: Date.now() };
    pt[phrase].count++;
    pt[phrase].users.add(message.author.id);
    // If a phrase has been said 5+ times by 2+ people, it's an inside joke
    if (pt[phrase].count >= 5 && pt[phrase].users.size >= 2) {
      const existing = await db.getUserPreferences(message.author.id);
      const topics = existing?.topics || [];
      if (!topics.some(t => t.topic === phrase)) {
        topics.push({ topic: phrase, type: "inside_joke", count: pt[phrase].count });
        await db.updateUserPreferences(message.author.id, { topics });
      }
    }
  }

  // ─── Sleep / Nap Detection ─────────────────────────────────────────
  const resolvedReply = result?.text || "";
  const sleepCheckMsg = cleanMessage || "";

  // Nap/sleep detection — ONLY owner and admins can tell her to nap/sleep
  const canControlSleep = message.author.id === config.ownerId || (message.member && (message.member.permissions?.has?.("Administrator") || message.member.permissions?.has?.("ManageGuild")));
  const userSaidNap = NAP_TRIGGERS.test(sleepCheckMsg);
  const botSaidNap = NAP_TRIGGERS.test(resolvedReply);
  if (canControlSleep && ((userSaidNap && botSaidNap) || (userSaidNap && sentimentScore >= 0))) {
    triggerSleep(true);
  } else if (botSaidNap && !userSaidNap) {
    triggerSleep(true); // Bot decided to nap on her own — always allow
  } else {
    const userSaidSleep = SLEEP_TRIGGERS.test(sleepCheckMsg);
    const botSaidSleep = SLEEP_TRIGGERS.test(resolvedReply);
    if ((canControlSleep && userSaidSleep && botSaidSleep) || (botSaidSleep && new Date().getHours() >= 22)) {
      triggerSleep(false);
    }
  }

  // Auto-sleep — if energy drops too low, she decides to rest on her own
  const currentMood = db.getMood();
  if (currentMood.energy <= 15 && !isSleeping()) {
    log(`[AUTO-SLEEP] Eris energy critically low (${currentMood.energy}), auto-napping`);
    try {
      // Defensive: re-check firewall verdict (verdict is cached at this point).
      await firewallGate(() => message.channel.send("im so tired... gonna take a quick nap, wake me up later 💤"));
    } catch (e) { log(`[MSG] ${e.message}`); }
    triggerSleep(true); // auto-nap, not full sleep
  }
}
