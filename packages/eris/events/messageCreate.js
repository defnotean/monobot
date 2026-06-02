/**
 * @file packages/eris/events/messageCreate.js
 * @module eris/events/messageCreate
 *
 * @summary Eris's main message-event handler — the front door to the entire
 *   AI conversation pipeline. Every Discord MESSAGE_CREATE gateway event
 *   lands here, gets gated, contextualized, sent to an LLM provider, post-
 *   processed, and persisted.
 *
 * @description
 *   This file is now a THIN ORCHESTRATOR. The pipeline stages live under
 *   `packages/eris/events/messageCreate/` as separate modules; the default
 *   export here just calls into them in the canonical order. Pipeline shape:
 *
 *     1. ENTRY              — partial fetch, self-message guard, dedup.
 *                             → `messageCreate/gates.js`
 *     2. GATING             — bump-service detection, sleep mode, bot/twin
 *                             filters, exploit pattern matches, repeat-spam
 *                             escalation, twin exchange counter, directive
 *                             silencing, mention/name/awaited-reply
 *                             detection, channel mute list, rate-limit
 *                             short-circuit, anti-spam cooldown,
 *                             message-length guard, firewall pre-dispatch.
 *                             → `messageCreate/gates.js`
 *     3. CONTEXT BUILDING   — relationship/mood/memory fetch, cross-channel
 *                             snippets, server persona, personality,
 *                             temporal context, mood modifiers, parallel
 *                             context fetch, slang guard, keyword-triggered
 *                             tool hints, response-style picker, group-chat
 *                             awareness, directives, novelty block, history
 *                             compression, tool profile selection,
 *                             humanity/twin context.
 *                             → `messageCreate/contextBuild.js`
 *                             Helpers: promptHints.js, turnBudget.js,
 *                             toolProfiles.js.
 *     4. AI CALL +          — `runGeminiChat(...)` via the provider router.
 *     5. TOOL DISPATCH        Tool-dispatch callback executes structured
 *                             tool calls inline via `executeTool`.
 *                             → `messageCreate/aiInvoke.js`
 *     6. RESPONSE RENDERING — strip leaked tool syntax (replyScrub.js),
 *                             resolve @username mentions, enforce char
 *                             budget, cached firewall gate on outbound,
 *                             `sendHumanReply` with realistic typing,
 *                             awaited-reply bookkeeping, sleep trigger
 *                             detection, 1% afterthought.
 *                             → `messageCreate/responsePostProcess.js`
 *     7. STATE PERSISTENCE  — push to in-memory `conversations` LRU, update
 *                             relationship/mood, personality tracking,
 *                             long-term episode extraction, passive coin
 *                             earn, inside-joke detection, auto-nap on
 *                             low energy.
 *                             → `messageCreate/analytics.js`
 *
 *   See `docs/ai-pipeline-eris.md` for the matching stage docs and
 *   `docs/start-here.md` for the first-time-reader walkthrough.
 */
// ─── packages/eris/events/messageCreate.js ──────────────────────────────
// Per-channel mutex (withLock) serializes concurrent messages in the same channel.
// See docs/start-here.md if you've never seen this file before.

import * as db from "../database.js";
import { log } from "../utils/logger.js";
import { logBlockedAttempt } from "../ai/firewall.js";
import { markActivity } from "./ready.js";
import { LRUCache } from "@defnotean/shared/LRUCache";

// ─── Per-phase modules (the split god-function lives here now) ──────────────
import { runGates } from "./messageCreate/gates.js";
import { withLock } from "./messageCreate/channelLock.js";
import { buildContext } from "./messageCreate/contextBuild.js";
import { invokeAI } from "./messageCreate/aiInvoke.js";
import { postProcessResponse } from "./messageCreate/responsePostProcess.js";
import { runAnalytics } from "./messageCreate/analytics.js";
import { triggerSleep, isSleeping, wakeSleep } from "./messageCreate/sleepState.js";
import { TOOL_CALL_DIRECTIVE } from "./messageCreate/constants.js";

// Re-export public surface — tests and other modules import these by name.
export { TOOL_CALL_DIRECTIVE };
export { triggerSleep, isSleeping, wakeSleep };

// Conversation history (in-memory, per channel, LRU eviction at 2000 channels)
// Conversations cache: 2000 channels × 10-50 msgs each = up to ~100MB if unbounded.
// 1h TTL so idle channels drop quickly and only actively-used conversations
// stay warm. compressHistory still enforces per-entry char budget.
const conversations = new LRUCache(2000, 60 * 60_000);
const TYPING_REFRESH_MS = 8_000;
const MAX_TYPING_REFRESH_MS = 45_000;

function startTypingRefresh(channel) {
  let interval = null;
  let timeout = null;
  const stop = () => {
    if (interval) clearInterval(interval);
    if (timeout) clearTimeout(timeout);
    interval = null;
    timeout = null;
  };

  channel.sendTyping().catch(() => {});
  interval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, TYPING_REFRESH_MS);
  timeout = setTimeout(stop, MAX_TYPING_REFRESH_MS);
  return stop;
}

// ─── 1. ENTRY + 2. GATING ───────────────────────────────────────────────
export default async function messageCreate(message) {
  const gate = await runGates(message);
  if (gate.stop) return;
  const { isTwin, isDM, isAwaitedReply, firewallPromise, channelKey } = gate;
  const client = message.client;

  // firewallGate: memoized verdict check. Either runs `sendCallback` (safe) or
  // sends the block reason (unsafe) and logs. Returns true iff the safe path ran.
  // It is called once before any context build / AI call / tool dispatch, then
  // reused by later send sites as a no-op safe verdict cache.
  let _firewallVerdict = null;
  let _firewallBlockSent = false;
  const firewallGate = async (sendCallback) => {
    if (!firewallPromise) { await sendCallback(); return true; }
    if (!_firewallVerdict) _firewallVerdict = await firewallPromise;
    if (!_firewallVerdict.safe) {
      if (!_firewallBlockSent) {
        _firewallBlockSent = true;
        await message.reply(_firewallVerdict.reason).catch(() => {});
        const sb = db.getSupabase();
        if (sb) logBlockedAttempt(sb, message.author.id, message.guildId, message.channel.id, message.content, _firewallVerdict.matchedPattern, _firewallVerdict.similarity).catch(() => {});
      }
      return false;
    }
    await sendCallback();
    return true;
  };

  // S-tier placement: block prompt-injection input before the LLM sees it and
  // before the inline tool-dispatch callback can execute anything.
  if (!(await firewallGate(async () => {}))) return;

  markActivity();
  log(`[MSG] ${isDM ? "DM" : `#${message.channel.name}`} from ${message.author.username}`);

  // Show typing indicator IMMEDIATELY — before the lock and heavy processing
  if (!isDM) message.channel.sendTyping().catch(() => {});

  await withLock(channelKey, async () => {
    let clearTypingInterval = () => {};
    try {
      if (!isDM) clearTypingInterval = startTypingRefresh(message.channel);

      // ─── 3. CONTEXT BUILDING ────────────────────────────────────────────
      const ctx = await buildContext({ message, isTwin, isDM, isAwaitedReply, channelKey, client, conversations });
      const { cleanMessage, displayName, botName, isTwinMsg, systemInstruction, history, userMsg, formattedTools, routerToolNames, charBudget } = ctx;

      // ─── 4. AI CALL  +  5. TOOL DISPATCH (inline callback) ──────────────
      const { result, skipped } = await invokeAI({ message, cleanMessage, systemInstruction, formattedTools, routerToolNames, history, userMsg, isTwinMsg });
      if (skipped) return; // No AI client configured — bail out before render.

      // ─── 6. RESPONSE RENDERING ──────────────────────────────────────────
      const post = await postProcessResponse({ message, result, cleanMessage, displayName, charBudget, isDM, isTwinMsg, firewallGate, botName, clearTypingInterval });
      // If firewall blocked the send (or the channel disappeared mid-flight),
      // skip the analytics pass — original behavior was to bail from the
      // entire withLock callback at that point.
      if (post.sendingSkipped) return;

      // ─── 7. STATE PERSISTENCE ───────────────────────────────────────────
      await runAnalytics({
        message,
        result,
        cleanMessage,
        sentimentScore: post.sentimentScore,
        isTwinMsg,
        isDM,
        gameEmbedSent: post.gameEmbedSent,
        history,
        channelKey,
        conversations,
        firewallGate,
      });

    } catch (error) {
      clearTypingInterval();
      const errMsg = error?.message || String(error);
      log(`[MSG] Error: ${errMsg}`);
      if (error?.stack) log(`[MSG] Stack: ${error.stack.split("\n").slice(0, 5).join(" | ")}`);

      // Friendly error messages instead of raw JSON/stack traces
      let friendlyMsg;
      if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        friendlyMsg = "my brain is overheating from too many conversations, gonna rest for a bit 💤";
      } else if (errMsg.includes("timed out")) {
        friendlyMsg = "that took too long, try again in a sec";
      } else if (errMsg.includes("SAFETY") || errMsg.includes("blocked")) {
        friendlyMsg = "i can't respond to that one, sorry";
      } else {
        friendlyMsg = "something broke, try again in a sec";
      }
      // Gate: if firewall flagged the input, send block reason instead of error reply.
      await firewallGate(() => message.reply(friendlyMsg).catch(() => {})).catch(() => {});
    } finally {
      clearTypingInterval();
    }
  });
}
