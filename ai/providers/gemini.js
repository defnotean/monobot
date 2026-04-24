// ─── Gemini AI Provider — adapter around the existing dual.js ───────────────
// dual.js doesn't export toGeminiTools or isRateLimited (they're internal),
// so this adapter provides safe stubs for the missing parts of the interface.

export {
  runGeminiChat,
  quickReply,
  looksLikeTask,
  setRateLimitCallbacks,
} from "../dual.js";

// dual.js handles tool conversion internally — callers don't need to format
// tools manually. Returning the raw tools makes the abstraction work.
export function toGeminiTools(tools) {
  return tools;
}

// dual.js doesn't expose a rate-limit check — assume keys are healthy.
export function isRateLimited() {
  return false;
}
