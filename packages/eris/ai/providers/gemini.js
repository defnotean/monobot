// ─── Gemini AI Provider — Google's Gemini via @google/genai ──────────────────
// Re-exports the existing Gemini implementation from ai/dual.js so it conforms
// to the provider interface. The actual logic lives in dual.js for now.
//
// To swap providers, set AI_PROVIDER=gemini in .env (default is nvidia).

export {
  runGeminiChat,
  quickReply,
  toGeminiTools,
  looksLikeTask,
  setRateLimitCallbacks,
  setWorkPool,
  isRateLimited,
} from "../dual.js";
