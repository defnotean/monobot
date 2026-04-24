// ai/contextCompressor.js — Progressive history compression
// Instead of hard-truncating old messages, compress them in tiers:
//   Tier A (recent 3 turns): Full detail
//   Tier B (turns 4-8):      Tool results summarized, bot text truncated
//   Tier C (turns 9+):       Ultra-compressed one-liners
// Format: Gemini { role, parts: [{ text }] }

/**
 * Compress conversation history to fit within a character budget.
 * Preserves recent context while summarizing older entries.
 * @param {Array} history - Gemini-format message array
 * @param {number} budget - Max total characters (default 8000)
 * @returns {Array} Compressed history (mutates in place for efficiency)
 */
export function compressHistory(history, budget = 8000) {
  if (!history || history.length === 0) return history;

  // Fast path: skip compression entirely if under budget and short enough
  const quickSize = history.reduce((sum, e) => sum + (e?.parts?.[0]?.text?.length || 0), 0);
  if (quickSize <= budget && history.length <= 20) return history;

  const len = history.length;
  // Define tier boundaries (counting from end)
  const tierAStart = Math.max(0, len - 6);  // last 3 turns = 6 entries (user+model)
  const tierBStart = Math.max(0, len - 16); // turns 4-8 = entries 7-16

  for (let i = 0; i < len; i++) {
    const entry = history[i];
    const text = entry?.parts?.[0]?.text || "";

    if (i < tierBStart) {
      // Tier C: ultra-compress
      const compressed = compressTierC(entry);
      if (entry.parts?.[0]) entry.parts[0].text = compressed;
    } else if (i < tierAStart) {
      // Tier B: moderate compression
      const compressed = compressTierB(entry);
      if (entry.parts?.[0]) entry.parts[0].text = compressed;
    }
    // Tier A: no compression
  }

  // Final size check — drop oldest if still over budget
  let totalSize = history.reduce((sum, e) => sum + (e?.parts?.[0]?.text?.length || 0), 0);
  while (history.length > 2 && totalSize > budget) {
    const removed = history.shift();
    totalSize -= (removed?.parts?.[0]?.text?.length || 0);
  }

  return history;
}

function compressTierB(entry) {
  const text = entry?.parts?.[0]?.text || "";
  if (!text) return text;

  if (entry.role === "model") {
    // Bot responses: first 200 chars
    if (text.length > 200) return text.slice(0, 200) + "...";
    return text;
  }

  // User messages: check if it contains tool result patterns
  if (text.includes("Tool result:") || text.includes("→")) {
    // Summarize tool results
    return summarizeToolText(text, 300);
  }

  // Regular user text: keep but cap at 400 chars
  if (text.length > 400) return text.slice(0, 400) + "...";
  return text;
}

function compressTierC(entry) {
  const text = entry?.parts?.[0]?.text || "";
  if (!text) return text;

  if (entry.role === "model") {
    // Bot: just keep the first sentence, no label prefix
    const firstSentence = text.match(/^[^.!?\n]+[.!?]?/)?.[0] || text.slice(0, 80);
    return firstSentence.slice(0, 100);
  }

  // User: extract the core request/topic
  const topic = extractTopic(text);
  return topic;
}

function extractTopic(text) {
  // Strip User ID prefix if present
  const cleaned = text.replace(/^\[User ID: \d+\]\s*\w+\s*says:\s*/i, "");

  if (cleaned.length <= 100) return cleaned;

  // Try to get first sentence
  const firstSentence = cleaned.match(/^[^.!?\n]+[.!?]?/)?.[0];
  if (firstSentence && firstSentence.length <= 120) return firstSentence;

  return cleaned.slice(0, 100) + "...";
}

function summarizeToolText(text, maxLen) {
  if (text.length <= maxLen) return text;

  // Extract tool names mentioned
  const toolMentions = text.match(/\b\w+_\w+\b/g) || [];
  const uniqueTools = [...new Set(toolMentions)].slice(0, 3);

  if (uniqueTools.length > 0) {
    return `[used tools: ${uniqueTools.join(", ")}] ${text.slice(0, 150)}...`;
  }

  return text.slice(0, maxLen) + "...";
}
