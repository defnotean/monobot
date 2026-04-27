// ─── AI Provider Router ─────────────────────────────────────────────────────
// Think of the AI as the brain — this router is the translator between the
// brain and the rest of Irene's body. Any model that implements the provider
// interface plugs in here, and nothing else needs to change.
//
// Each provider exports:
//   - runGeminiChat(opts)      → main chat with tool calling
//   - quickReply(...)          → fast acknowledgment without tools
//   - toGeminiTools(tools)     → convert tool schemas to provider format
//   - looksLikeTask(text)      → heuristic for routing chat vs tasks
//   - setRateLimitCallbacks()  → wire up per-key rate limit hooks
//   - isRateLimited()          → bool, check if all keys are exhausted
//
// To add a new brain (Anthropic, OpenAI, Groq, local Ollama, etc.):
//   1. Create ai/providers/<name>.js implementing the interface above
//   2. Add a case to the switch below
//   3. Set AI_PROVIDER=<name> in .env

import config from "../../config.js";
import { log } from "../../utils/logger.js";

// Default to "gemini" to match config.js's documented default. The previous
// "|| nvidia" silently flipped to NVIDIA if config.aiProvider was ever empty,
// contradicting the .env.example documentation. Startup validation in
// config.js now also fails fast on unrecognized values.
const PROVIDER = (config.aiProvider || "gemini").toLowerCase();

let provider;
switch (PROVIDER) {
  case "nvidia":
  case "kimi":
    provider = await import("./nvidia.js");
    log(`[AI] Provider: NVIDIA (${config.nvidia?.model || "unknown"})`);
    break;
  case "gemini":
  case "google":
    provider = await import("./gemini.js");
    log("[AI] Provider: Google Gemini");
    break;
  default:
    // Should be unreachable thanks to config.js validation, but kept as a
    // last-resort guard so we never silently load the wrong provider.
    log(`[AI] Unknown provider "${PROVIDER}" — falling back to Gemini`);
    provider = await import("./gemini.js");
}

export const runGeminiChat = provider.runGeminiChat;
export const quickReply = provider.quickReply;
export const toGeminiTools = provider.toGeminiTools;
export const looksLikeTask = provider.looksLikeTask;
export const setRateLimitCallbacks = provider.setRateLimitCallbacks;
export const isRateLimited = provider.isRateLimited;
export const activeProvider = PROVIDER;
