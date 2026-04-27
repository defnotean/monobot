// ─── AI Provider Router ─────────────────────────────────────────────────────
// Dispatches AI calls to the active provider based on config.aiProvider.
//
// Each provider must export this interface:
//   - runGeminiChat(client, sysInstr, tools, history, userMsg, executor, opts)
//   - quickReply(client, sysInstr, userText, context)
//   - toGeminiTools(tools)
//   - looksLikeTask(text)
//   - setRateLimitCallbacks(onLimit, onSuccess)
//   - isRateLimited()
//
// To add a new provider (e.g. Anthropic, OpenAI, Groq):
//   1. Create ai/providers/anthropic.js implementing the interface above
//   2. Add it to the switch below
//   3. Set AI_PROVIDER=anthropic in .env

import config from "../../config.js";
import { log } from "../../utils/logger.js";

// Default to "gemini" to match config.js's documented default. The previous
// "|| nvidia" silently flipped to NVIDIA if config.aiProvider was ever empty.
const PROVIDER = (config.aiProvider || "gemini").toLowerCase();
const FALLBACK_ENABLED = config.aiProviderFallback !== false; // opt-out via config

let primary;
let fallback = null;
switch (PROVIDER) {
  case "nvidia":
  case "kimi":
    if (!config.nvidia?.apiKey) {
      log("[AI] FATAL: aiProvider=nvidia but NVIDIA_API_KEY is not set in .env");
      throw new Error("NVIDIA_API_KEY required when aiProvider=nvidia");
    }
    primary = await import("./nvidia.js");
    log(`[AI] Provider: NVIDIA (${config.nvidia?.model || "unknown"})`);
    if (FALLBACK_ENABLED) {
      try {
        fallback = await import("./gemini.js");
        log("[AI] Fallback provider: Gemini (activated only if NVIDIA circuit opens)");
      } catch (err) {
        log(`[AI] Gemini fallback unavailable: ${err.message}`);
      }
    }
    break;
  case "gemini":
  case "google":
    primary = await import("./gemini.js");
    log("[AI] Provider: Google Gemini");
    break;
  default:
    // Should be unreachable thanks to config.js validation; kept as a
    // last-resort guard so we never silently load the wrong provider.
    log(`[AI] Unknown provider "${PROVIDER}" — falling back to Gemini`);
    primary = await import("./gemini.js");
}

// ─── Fallback-wrapped runGeminiChat ─────────────────────────────────────────
// If the primary provider's circuit is open (too many consecutive failures),
// route the call to the fallback so users aren't staring at a dead bot.
// Generic-error strings from the primary are also treated as a failure signal.
const PRIMARY_FAILURE_MARKERS = [
  "i'm having trouble thinking rn",
  "gemini is overloaded",
];

async function runWithFallback(...args) {
  if (!fallback) return primary.runGeminiChat(...args);

  // If the primary is circuit-open, go straight to fallback (no retry churn).
  if (primary.isRateLimited?.()) {
    log("[AI] primary circuit open — routing directly to fallback");
    return fallback.runGeminiChat(...args);
  }

  const result = await primary.runGeminiChat(...args);
  const text = (result?.text || "").toLowerCase();
  if (PRIMARY_FAILURE_MARKERS.some((m) => text.includes(m))) {
    log("[AI] primary returned a failure marker — retrying on fallback");
    try {
      return await fallback.runGeminiChat(...args);
    } catch (err) {
      log(`[AI] fallback also failed: ${err.message}`);
      return result; // stick with primary's message
    }
  }
  return result;
}

// Re-export the active primary's interface, with runGeminiChat wrapped in fallback
export const runGeminiChat = fallback ? runWithFallback : primary.runGeminiChat;
export const quickReply = primary.quickReply;
export const toGeminiTools = primary.toGeminiTools;
export const looksLikeTask = primary.looksLikeTask;
export const setRateLimitCallbacks = primary.setRateLimitCallbacks;
export const isRateLimited = primary.isRateLimited;

export const activeProvider = PROVIDER;
export const hasFallback = !!fallback;
