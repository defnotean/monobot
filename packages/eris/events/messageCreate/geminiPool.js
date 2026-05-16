// ─── packages/eris/events/messageCreate/geminiPool.js ───────────────────────
// Per-key Gemini client pool. Held at module scope so a single pool is shared
// across every messageCreate invocation. The pool is conditionally created
// — when the active provider is not Gemini, we keep the API surface but
// return null clients (the orchestrator's existing fallback path covers it).

import { GoogleGenAI } from "@google/genai";
import { createSplitPools } from "@defnotean/shared/keyPool";
import { log } from "../../utils/logger.js";
import config from "../../config.js";

export function activeProviderNeedsGeminiClient() {
  return ["gemini", "google"].includes((config.aiProvider || "").toLowerCase());
}

export function activeProviderLabel() {
  return config.openaiCompat?.providerName || config.aiProvider || "AI";
}

export const _geminiPools = activeProviderNeedsGeminiClient()
  ? createSplitPools("gemini", config.geminiKeys, GoogleGenAI, { log })
  : {};

export function getConvClient() { return _geminiPools.conv?.get() || null; }
export function getWorkClient() { return _geminiPools.work?.get() || null; }
