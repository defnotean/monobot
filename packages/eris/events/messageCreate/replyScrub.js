// ─── packages/eris/events/messageCreate/replyScrub.js ───────────────────────
// Sanitize an LLM reply before sending — strips leaked tool-call syntax,
// leaked tool-usage labels, leaked context labels, code-style tool calls,
// and other "model emitted the wrong format" pollution. The orchestrator
// runs this before any user-visible delivery.

/**
 * Remove leaked tool/function-call syntax and bot scaffolding from an LLM
 * reply. Returns the cleaned reply. The behavior is identical to the inline
 * regex parade in messageCreate.js — pure string transforms, no I/O.
 *
 * @param {string} reply Raw reply text from the model.
 * @returns {string} Reply with leaked syntax stripped (may be empty).
 */
export function scrubLeakedToolSyntax(reply) {
  // Strip leaked function-call text — model sometimes outputs send_gif(query="x") as plain text
  // instead of (or in addition to) an actual API function call. Remove those lines entirely.
  reply = reply.replace(/^[a-z][a-z0-9_]*\([^)]*\)\s*$/gim, "").trim();
  // Strip leaked tool-usage labels — "[used search_location]" etc.
  reply = reply.replace(/\[used [^\]]+\]/gi, "").trim();
  // Strip leaked twin/bot tool-block summaries from history
  reply = reply.replace(/\[twin\/bot used [^\]]+\]/gi, "").trim();
  reply = reply.replace(/\[twin\/bot previously used: [^\]]+\]/gi, "").trim();
  reply = reply.replace(/\[result:[^\]]*\]/gi, "").trim();
  reply = reply.replace(/\[previous action(?: taken)?\]/gi, "").trim();
  // Strip leaked tool_code/tool_call blocks (multiple formats the model uses)
  reply = reply.replace(/<tool_code>[\s\S]*?<\/tool_code>/gi, "").trim();
  reply = reply.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
  reply = reply.replace(/<function_call>[\s\S]*?<\/function_call>/gi, "").trim();
  // Strip leaked bracket-style tool call markers — `[tool call: name]{json}` with
  // an optional balanced JSON or arg list. The provider's history converter
  // (toMessages in providers/openaiCompat.js) renders past tool calls in this
  // exact format, so the model learns to imitate it in fresh content.
  reply = reply.replace(/\[tool[\s_-]?call:?\s*[^\]]+\]\s*(?:\{[\s\S]*?\}|\([^)]*\))?/gi, "").trim();
  reply = reply.replace(/\[tool[\s_-]?result:?\s*[^\]]+\][^\n]*/gi, "").trim();
  reply = reply.replace(/\[tool[\s_-]?runtime[^\]]*\]/gi, "").trim();
  reply = reply.replace(/\[function[\s_-]?call:?\s*[^\]]+\]\s*(?:\{[\s\S]*?\})?/gi, "").trim();
  // Strip leaked code-style tool calls — print(tool_name()), tool_name(), etc.
  reply = reply.replace(/^\s*print\([^)]*\)\s*$/gim, "").trim();
  reply = reply.replace(/^\s*[a-z_]+\s*\(.*?\)\s*$/gim, "").trim();
  // Strip leaked context labels — "[Eris said]", "[username said]", "[SYSTEM: ...]"
  reply = reply.replace(/\[(?:eris|irene|[^\]]{1,30})\s+said\]/gi, "").trim();
  reply = reply.replace(/\[SYSTEM:[^\]]*\]/gi, "").trim();
  return reply;
}
