// ─── packages/irene/events/messageCreate/responsePostProcess.js ───────────
// Reply rendering pipeline: strip leaked tool-call syntax + context labels,
// resolve @mentions to Discord pings, enforce the per-turn char budget,
// split into ≤2000-char chunks, and send via human-timed delivery.

import { MessageFlags } from "discord.js";
import { log } from "../../utils/logger.js";

// Lazy import — humanDelay is cold-path until the AI replies.
let _modHumanDelay;
const lazyHumanDelay = async () => (_modHumanDelay ??= await import("@defnotean/shared/humanDelay"));

// Split a long string into ≤limit-char chunks on word boundaries.
export function splitMessage(text, limit = 2000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const cut = remaining.lastIndexOf(" ", limit);
    const pos = cut > limit * 0.75 ? cut : limit;
    chunks.push(remaining.slice(0, pos));
    remaining = remaining.slice(pos).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Strip leaked function-call text — model sometimes outputs send_gif(query="x")
// as plain text instead of (or in addition to) an actual API function call.
// Remove those lines entirely. Also strips leaked tool_code/tool_call blocks,
// bracket-style markers, context labels, and twin/bot tool-block summaries.
export function stripLeakedToolSyntax(reply) {
  let cleanedReply = reply.replace(/^[a-z][a-z0-9_]*\([^)]*\)\s*$/gim, "").trim();
  cleanedReply = cleanedReply.replace(/<tool_code>[\s\S]*?<\/tool_code>/gi, "").trim();
  cleanedReply = cleanedReply.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
  cleanedReply = cleanedReply.replace(/<function_call>[\s\S]*?<\/function_call>/gi, "").trim();
  // Strip leaked bracket-style tool call markers — `[tool call: name]{json}` with
  // an optional JSON body that may span lines. These leak because the provider's
  // history converter (toMessages) renders past tool calls in this exact format
  // for replay, so the model learns to imitate it in fresh content. Match the
  // marker plus any immediately-following balanced JSON object.
  cleanedReply = cleanedReply.replace(/\[tool[\s_-]?call:?\s*[^\]]+\]\s*(?:\{[\s\S]*?\}|\([^)]*\))?/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[tool[\s_-]?result:?\s*[^\]]+\][^\n]*/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[tool[\s_-]?runtime[^\]]*\]/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[function[\s_-]?call:?\s*[^\]]+\]\s*(?:\{[\s\S]*?\})?/gi, "").trim();
  // Strip leaked code-style tool calls — print(tool_name()), tool_name(), etc.
  cleanedReply = cleanedReply.replace(/^\s*print\([^)]*\)\s*$/gim, "").trim();
  cleanedReply = cleanedReply.replace(/^\s*[a-z_]+\s*\(.*?\)\s*$/gim, "").trim();
  // Strip leaked brace-style tool calls — `web_search {query: "..."}` followed
  // by any leaked inner-reasoning trailing on the same line. Gemini emits this
  // when it verbalises a tool call instead of (or in addition to) an actual
  // functionCall part — strip from the tool name through end-of-line so the
  // parenthetical "(just in case...)" reasoning trailing it doesn't leak.
  cleanedReply = cleanedReply.replace(/^[a-z][a-z0-9_]*\s*\{[\s\S]*?\}[^\n]*/gm, "").trim();
  // Strip leaked context labels — model sometimes regurgitates [Irene said] [Eris said] etc.
  cleanedReply = cleanedReply.replace(/\[(?:irene|eris|[^\]]{1,30})\s+said\]/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[SYSTEM:[^\]]*\]/gi, "").trim();
  // Strip leaked twin/bot tool-block summaries — model regurgitates these from history
  cleanedReply = cleanedReply.replace(/\[twin\/bot used [^\]]+\]/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[twin\/bot previously used: [^\]]+\]/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[result:[^\]]*\]/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[previous action(?: taken)?\]/gi, "").trim();
  cleanedReply = cleanedReply.replace(/\[used [^\]]+\]/gi, "").trim();
  // Re-collapse whitespace after stripping
  cleanedReply = cleanedReply.replace(/\n{2,}/g, "\n").trim();
  return cleanedReply;
}

// Resolve @username mentions in AI response to proper Discord <@id> pings.
// Self-mention guard: if the model wrote "@Irene" while it IS Irene, the
// converted <@self_id> makes the bot ping itself, which Discord renders as
// a literal "@Irene" in her own message — clear identity-confusion artifact.
// Strip the @ for self-references; the name stays as plain text.
export function resolveAtMentions(cleanedReply, guild, fallbackReply) {
  if (!guild) return cleanedReply;
  const selfId = guild.client?.user?.id;
  return (cleanedReply || fallbackReply).replace(/@(\w+)/g, (match, name) => {
    const member = guild.members.cache.find(
      m => m.user.username.toLowerCase() === name.toLowerCase()
        || m.displayName.toLowerCase() === name.toLowerCase()
    );
    if (!member) return match;
    if (member.id === selfId) return name; // self-mention → plain text
    return `<@${member.id}>`;
  });
}

// Enforce per-turn character budget set during prompt assembly. Prompt rules
// alone drift back to 400-600 char replies even for casual chat. Trim to the
// last complete sentence at/under the budget; fall back to a hard slice only
// if no sentence boundary exists within range.
export function enforceCharBudget(resolvedReply, budget) {
  if (!budget || resolvedReply.length <= budget) return resolvedReply;
  const before = resolvedReply.length;
  // Search for the last sentence terminator within the budget window.
  // Allow a 1.2x grace so we don't cut an otherwise-fine short message.
  const grace = Math.floor(budget * 1.2);
  if (resolvedReply.length <= grace) return resolvedReply;

  const slice = resolvedReply.slice(0, budget);
  const lastEnd = Math.max(
    slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "),
    slice.lastIndexOf(".\n"), slice.lastIndexOf("!\n"), slice.lastIndexOf("?\n"),
    slice.endsWith(".") || slice.endsWith("!") || slice.endsWith("?") ? slice.length - 1 : -1,
  );
  let trimmed;
  if (lastEnd > budget * 0.4) {
    trimmed = resolvedReply.slice(0, lastEnd + 1).trim();
  } else {
    // No clean boundary — cut at last space before budget to avoid mid-word.
    const sp = slice.lastIndexOf(" ");
    trimmed = (sp > budget * 0.4 ? slice.slice(0, sp) : slice).trim();
  }
  log(`[LENGTH] Trimmed reply ${before} → ${trimmed.length} chars (budget ${budget})`);
  return trimmed;
}

// Send reply chunks with realistic human typing pacing and mid-reply splits
// at natural breakpoints. Falls back to a naive loop for the rare >2000-char
// multi-chunk case so no text is lost.
export async function sendReplyChunks(message, chunks) {
  const suppressOpts = { flags: MessageFlags.SuppressEmbeds };
  const { sendHumanReply } = await lazyHumanDelay();

  if (chunks.length === 1) {
    await sendHumanReply(message, chunks[0], { isDM: !message.guild, messageOptions: suppressOpts });
  } else {
    for (const chunk of chunks) {
      await sendHumanReply(message, chunk, { isDM: !message.guild, allowSplit: false, messageOptions: suppressOpts });
    }
  }
}
