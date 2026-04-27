// ai/contextCompressor.js — Progressive history compression
// Instead of hard-truncating old messages, compress them in tiers:
//   Tier A (recent 3 turns): Full detail
//   Tier B (turns 4-8):      Tool results summarized, bot text truncated
//   Tier C (turns 9+):       Ultra-compressed one-liners
// Format: Anthropic { role, content: string | [blocks] }

/**
 * Compress conversation history to fit within a character budget.
 * Preserves recent context while summarizing older entries.
 * Also sanitizes orphaned tool_result blocks.
 * @param {Array} history - Anthropic-format message array
 * @param {number} budget - Max total characters (default 8000)
 * @returns {Array} Compressed history (mutates in place for efficiency)
 */
export function compressHistory(history, budget = 8000) {
  if (!history || history.length === 0) return history;

  // First: sanitize — remove orphaned leading entries
  sanitizeHistory(history);

  // Fast path: if under budget and short enough, skip tier compression entirely
  const quickSize = history.reduce((sum, e) => sum + getEntrySize(e), 0);
  if (quickSize <= budget && history.length <= 20) return history;

  const len = history.length;
  const tierAStart = Math.max(0, len - 6);  // last 3 turns = 6 entries
  const tierBStart = Math.max(0, len - 16); // turns 4-8

  for (let i = 0; i < len; i++) {
    if (i < tierBStart) {
      compressEntryTierC(history[i]);
    } else if (i < tierAStart) {
      compressEntryTierB(history[i]);
    }
    // Tier A: no compression
  }

  // Final size check — drop oldest entries while keeping history[0] intact.
  // The first user turn is "what the user originally asked for" — losing it
  // under heavy context makes the model forget the task entirely. Splice from
  // index 1 instead of shift()ing index 0.
  let totalSize = history.reduce((sum, e) => sum + getEntrySize(e), 0);
  while (history.length > 2 && totalSize > budget) {
    const removed = history.splice(1, 1)[0];
    if (!removed) break;
    totalSize -= getEntrySize(removed);
  }

  // Re-sanitize after potential removals
  sanitizeHistory(history);

  return history;
}

function getEntrySize(entry) {
  if (typeof entry.content === "string") return entry.content.length;
  if (Array.isArray(entry.content)) return JSON.stringify(entry.content).length;
  return 0;
}

function compressEntryTierB(entry) {
  if (entry.role === "assistant") {
    if (typeof entry.content === "string" && entry.content.length > 200) {
      entry.content = entry.content.slice(0, 200) + "...";
    }
    // Assistant with tool_use blocks: summarize tool names
    if (Array.isArray(entry.content)) {
      const toolNames = entry.content
        .filter(b => b.type === "tool_use")
        .map(b => b.name);
      const textParts = entry.content
        .filter(b => b.type === "text")
        .map(b => b.text?.slice(0, 150))
        .join(" ");
      if (toolNames.length > 0) {
        entry.content = `[used ${toolNames.join(", ")}] ${textParts}`.slice(0, 300);
        entry.role = "assistant"; // keep role
      }
    }
  }

  if (entry.role === "user") {
    if (typeof entry.content === "string" && entry.content.length > 400) {
      entry.content = entry.content.slice(0, 400) + "...";
    }
    // User with tool_result blocks: summarize results
    if (Array.isArray(entry.content)) {
      const summaries = entry.content.map(b => {
        if (b.type === "tool_result") {
          const result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          return `[result: ${result.slice(0, 80)}]`;
        }
        return b.text || "";
      });
      entry.content = summaries.join(" ").slice(0, 300);
    }
  }
}

function compressEntryTierC(entry) {
  if (entry.role === "assistant") {
    const text = typeof entry.content === "string"
      ? entry.content
      : Array.isArray(entry.content)
        ? entry.content.filter(b => b.type === "text").map(b => b.text).join(" ")
        : "";
    const toolNames = Array.isArray(entry.content)
      ? entry.content.filter(b => b.type === "tool_use").map(b => b.name)
      : [];
    const firstSentence = text.match(/^[^.!?\n]+[.!?]?/)?.[0] || text.slice(0, 80);
    const toolSuffix = toolNames.length > 0 ? ` [tools: ${toolNames.join(",")}]` : "";
    entry.content = firstSentence.slice(0, 100) + toolSuffix;
  }

  if (entry.role === "user") {
    if (Array.isArray(entry.content)) {
      // Summarize each tool_result with its first ~40 chars instead of dropping
      // them entirely. The old "[previous tool results]" stub made Irene forget
      // what happened in earlier turns, so she'd re-ask or re-execute things
      // (e.g. setup flows where she'd created a role then forgotten it existed).
      const summaries = entry.content.map(b => {
        if (b.type === "tool_result") {
          const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          const trimmed = raw.replace(/\s+/g, " ").trim().slice(0, 40);
          return trimmed ? `[${trimmed}]` : "[done]";
        }
        return b.text?.slice(0, 60) || "";
      }).filter(Boolean);
      entry.content = summaries.length ? summaries.join(" ").slice(0, 200) : "[previous tool results]";
    } else if (typeof entry.content === "string") {
      // Extract topic
      const cleaned = entry.content.replace(/^\[\w+\]\n?/, "");
      if (cleaned.length > 100) {
        const firstSentence = cleaned.match(/^[^.!?\n]+[.!?]?/)?.[0] || cleaned.slice(0, 80);
        entry.content = firstSentence.slice(0, 120);
      }
    }
  }
}

/**
 * Remove invalid leading entries (orphaned tool_results, leading assistant messages)
 */
function sanitizeHistory(history) {
  while (history.length > 0) {
    const first = history[0];
    // Must start with user message
    if (first.role === "assistant") { history.shift(); continue; }
    // User message of only tool_results with no preceding tool_use = orphaned
    if (
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content.length > 0 &&
      first.content.every(b => b.type === "tool_result")
    ) { history.shift(); continue; }
    break;
  }
}
