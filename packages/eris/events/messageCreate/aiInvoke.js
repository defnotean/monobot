// ─── packages/eris/events/messageCreate/aiInvoke.js ─────────────────────────
// Stage 4 + 5 — call the active LLM provider and dispatch any structured
// tool calls it emits. The "quick reply ack" + rate-limit pool wiring also
// happen here since they're directly tied to the AI call itself.

import config from "../../config.js";
import * as db from "../../database.js";
import { log } from "../../utils/logger.js";
import { runGeminiChat, looksLikeTask, quickReply, setRateLimitCallbacks } from "../../ai/providers/index.js";
import { executeTool } from "../../ai/executor.js";

import { activeProviderNeedsGeminiClient, activeProviderLabel, getConvClient, getWorkClient, _geminiPools } from "./geminiPool.js";

/**
 * Run the AI call (and inline tool-dispatch callback). Returns the model
 * result plus the AI-call duration in ms.
 *
 * @param {object} opts
 * @param {import("discord.js").Message} opts.message
 * @param {string} opts.cleanMessage
 * @param {string} opts.systemInstruction
 * @param {object} opts.formattedTools
 * @param {string[]} [opts.routerToolNames]
 * @param {object[]} opts.history
 * @param {string} opts.userMsg
 * @param {boolean} opts.isTwinMsg
 * @returns {Promise<{ result: any, aiMs: number, skipped?: boolean }>}
 */
export async function invokeAI({ message, cleanMessage, systemInstruction, formattedTools, routerToolNames = [], history, userMsg, isTwinMsg }) {
  const workClient = getWorkClient();
  if (!workClient && activeProviderNeedsGeminiClient()) {
    await message.reply("no AI keys configured - can't respond right now").catch(() => {});
    return { result: null, aiMs: 0, skipped: true };
  }

  // Quick reply for task-like messages (not for twin, not for games/gambling, not for sister talk)
  const isGameMsg = /\b(bet|gamble|flip|slots?|spin|blackjack|hit|stand|double|roll|dice|daily|rob|steal|duel|challenge|accept|trivia|scramble|guess|roulette|rps|rock|paper|scissors|fortune|confess|curse|balance|coins?|leaderboard)\b/i.test(cleanMessage);
  const isSisterMsg = /\b(sister|twin|irene|talk to|tell her|tell your|ask her|ask your)\b/i.test(cleanMessage);
  if (!isTwinMsg && !isGameMsg && !isSisterMsg && looksLikeTask(cleanMessage)) {
    // Quick-reply is a Gemini-only acknowledgement pattern (fast flash model
    // posting an ack while the slow worker call runs). On OpenRouter / NVIDIA
    // the worker call IS the same model, and quickReply.context.reply() posts
    // a second visible Discord reply — making the bot say "ok will do" while
    // the tool-using path tries to do the actual work. Skip it entirely
    // unless the active provider has a separate fast client.
    if (activeProviderNeedsGeminiClient()) {
      const convClient = getConvClient();
      if (convClient) quickReply(convClient, systemInstruction, cleanMessage, message).catch(() => {});
    }
  }

  // Wire up per-key rate limit callbacks for the pool
  try {
    // setRateLimitCallbacks now static import
    if (activeProviderNeedsGeminiClient()) {
      setRateLimitCallbacks(
        (client, durationMs) => _geminiPools.work?.markRateLimited(client, durationMs),
        (client) => _geminiPools.work?.markSuccess(client),
      );
    } else {
      setRateLimitCallbacks(null, null);
    }
  } catch (e) { log(`[MSG] ${e.message}`); }

  // ─── 4. AI CALL  +  5. TOOL DISPATCH (inline callback) ──────────────
  // Main AI call
  const t0Ai = Date.now();
  const aiPromise = runGeminiChat(workClient, systemInstruction, formattedTools, history, userMsg, async (toolName, toolArgs) => {
    db.logToolUsage(toolName, message.author.id, message.channel.id);
    // executeTool now static import
    const t0 = Date.now();
    const toolResult = await executeTool(toolName, toolArgs, message);
    const elapsed = Date.now() - t0;
    if (elapsed > 2000) log(`[TOOL] ${toolName} took ${elapsed}ms (slow)`);
    return toolResult;
  }, { routerToolNames });

  // Outer turn deadline — the OpenAI-compat lane can spin many iterations of
  // slow calls while this await holds the per-channel lock, wedging the
  // channel. Race against config.timeouts.turnDeadline (mirrors Irene's
  // orchestrator race) and resolve with the standard error-reply shape so
  // downstream rendering — and the lock release — proceed normally. The
  // orphaned provider promise is detached, not cancelled; Promise.race keeps
  // its eventual rejection handled.
  const turnDeadlineMs = config.timeouts?.turnDeadline ?? 180_000;
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => {
      log(`[MSG] ${activeProviderLabel()} turn exceeded ${Math.ceil(turnDeadlineMs / 1000)}s deadline — releasing channel`);
      resolve({ text: "that took too long, try again in a sec", toolsUsed: [] });
    }, turnDeadlineMs);
  });
  const result = await Promise.race([aiPromise, deadline]).finally(() => clearTimeout(deadlineTimer));

  const aiMs = Date.now() - t0Ai;
  if (aiMs > 5000) log(`[PERF] ${activeProviderLabel()} took ${aiMs}ms (prompt ${systemInstruction.length} chars, history ${history.length} msgs)`);

  return { result, aiMs };
}
