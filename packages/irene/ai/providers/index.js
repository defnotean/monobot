// AI Provider Router
//
// Each provider exports:
//   - runGeminiChat(opts)      -> main chat with tool calling
//   - quickReply(...)          -> fast acknowledgment without tools
//   - toGeminiTools(tools)     -> convert tool schemas to provider format
//   - looksLikeTask(text)      -> heuristic for routing chat vs tasks
//   - setRateLimitCallbacks()  -> wire up per-key rate limit hooks
//   - isRateLimited()          -> bool, check if all keys are exhausted

import config from "../../config.js";
import { log } from "../../utils/logger.js";

const PROVIDER = (config.aiProvider || "gemini").toLowerCase();
const OPENAI_COMPAT_ALIASES = new Set([
  "openai-compatible",
  "openaicompatible",
  "openai_compatible",
  "openai-compat",
  "openai",
  "openrouter",
  "groq",
  "cerebras",
  "mistral",
  "deepinfra",
  "together",
  "github",
  "cloudflare",
  "lmstudio",
  "ollama",
]);

let provider;
if (OPENAI_COMPAT_ALIASES.has(PROVIDER)) {
  provider = await import("./openaiCompat.js");
  log(`[AI] Provider: OpenAI-compatible (${config.openaiCompat?.providerName || PROVIDER}: ${config.openaiCompat?.model || "unknown"})`);
} else {
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
      log(`[AI] Unknown provider "${PROVIDER}" - falling back to Gemini`);
      provider = await import("./gemini.js");
  }
}

export const runGeminiChat = provider.runGeminiChat;
export const quickReply = provider.quickReply;
export const toGeminiTools = provider.toGeminiTools;
export const looksLikeTask = provider.looksLikeTask;
export const setRateLimitCallbacks = provider.setRateLimitCallbacks;
export const isRateLimited = provider.isRateLimited;
export const activeProvider = PROVIDER;
