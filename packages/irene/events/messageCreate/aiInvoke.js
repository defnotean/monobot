// ─── packages/irene/events/messageCreate/aiInvoke.js ──────────────────────
// Wraps the AI invocation phase: dual-AI ack timer, typing indicator,
// per-key rate-limit callbacks, prompt budgeting, and the runGeminiChat
// call itself. Tool dispatch happens inside runGeminiChat (see
// providers/index.js → dual.js); this module just orchestrates the call.

import { MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { runGeminiChat, quickReply, looksLikeTask } from "../../ai/providers/index.js";
import { setRateLimitCallbacks } from "../../ai/providers/index.js";
import { createSplitPools } from "@defnotean/shared/keyPool";
import {
  applyPromptBudget as applySharedPromptBudget,
  resolvePromptCharBudget,
} from "@defnotean/shared/promptBudget";

// ── Smart Gemini key pool — per-key rate limit tracking ───────────────────
// With 12 keys: keys 0,2,4,6,8,10 → conversation, keys 1,3,5,7,9,11 → worker
// If one key hits 429, only THAT key pauses — others keep serving requests.
export function activeProviderNeedsGeminiClient() {
  return ["gemini", "google"].includes((config.aiProvider || "").toLowerCase());
}
export function activeProviderLabel() {
  return config.openaiCompat?.providerName || config.aiProvider || "AI";
}

const _geminiPools = activeProviderNeedsGeminiClient()
  ? createSplitPools("gemini", config.geminiKeys, GoogleGenAI, { log })
  : {};

export function getConvClient() { return _geminiPools.conv?.get() || null; }
export function getGeminiClient() { return _geminiPools.work?.get() || null; }
export function hasWorkPool() { return !!_geminiPools.work; }

// Prompt char budget. Exported so callers/tests share one source of truth.
// Default stays generous for local models; set AI_PROMPT_CHAR_BUDGET lower for
// cloud deployments.
export const PROMPT_BUDGET = resolvePromptCharBudget(config.aiPromptCharBudget);

// Trim core personality to make room for runtime context.
export function applyPromptBudget(systemPromptWithMemory) {
  return applySharedPromptBudget(systemPromptWithMemory, { budget: PROMPT_BUDGET, log });
}

// Wire up per-key rate limit callbacks for the pool that actually owns this
// client. Conversational (fast) path uses conv pool; worker path uses work.
export function wireRateLimitCallbacks(isTask) {
  try {
    if (activeProviderNeedsGeminiClient()) {
      const activePool = isTask ? _geminiPools.work : (_geminiPools.conv ?? _geminiPools.work);
      setRateLimitCallbacks(
        (client, durationMs) => activePool?.markRateLimited(client, durationMs),
        (client) => activePool?.markSuccess(client),
      );
    } else {
      setRateLimitCallbacks(null, null);
    }
  } catch {}
}

// Re-export looksLikeTask so the orchestrator imports just from this module
export { looksLikeTask, quickReply };
