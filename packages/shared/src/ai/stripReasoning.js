// ─── packages/shared/src/ai/stripReasoning.js ──────────────────────────────
// Strip chain-of-thought "reasoning" blocks from OpenAI-compatible chat
// content. Local reasoning models (Qwen3 / DeepSeek-R1 class) ship with
// thinking enabled and leak CoT into message.content as <think>...</think>
// blocks — or, when max_tokens truncates the response mid-thought, as an
// UNCLOSED <think> block with no visible reply after it. A third form appears
// when the serving chat template PRE-FILLS the opening <think> into the prompt
// (common for DeepSeek-R1): the response content then carries only the CoT
// followed by a lone closing </think>, with no opening tag. All three forms
// must never reach Discord, conversation history, or the rescue parser.

const CLOSED_THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const OPEN_THINK_RE = /<think>/i;
const ORPHAN_CLOSE_RE = /^[\s\S]*?<\/think>/i;

/**
 * Remove <think>...</think> reasoning blocks (case-insensitive, multiline,
 * any number of blocks); any unclosed <think> block that truncated outputs
 * produce (orphan open tag → strip from the tag to end-of-string); and an
 * orphan CLOSING </think> with no preceding opener (prompt pre-filled the
 * <think>) → strip everything up to and including the close tag. A think-only
 * response collapses to "" — callers already handle empty model text via their
 * finish_reason fallbacks.
 *
 * @param {unknown} text raw model content
 * @returns {string} cleaned, trimmed text
 */
export function stripReasoning(text) {
  if (typeof text !== "string" || !text) return "";
  let out = text.replace(CLOSED_THINK_RE, "");
  const openIdx = out.search(OPEN_THINK_RE);
  if (openIdx !== -1) {
    // Unclosed opener: drop from it to end-of-string.
    out = out.slice(0, openIdx);
  } else if (/<\/think>/i.test(out)) {
    // Orphan closing tag (no opener left after the closed-block pass): the
    // leading text is pre-filled chain-of-thought. Drop through the close tag.
    out = out.replace(ORPHAN_CLOSE_RE, "");
  }
  return out.trim();
}
