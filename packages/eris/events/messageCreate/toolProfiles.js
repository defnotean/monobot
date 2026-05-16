// ─── packages/eris/events/messageCreate/toolProfiles.js ─────────────────────
// Pre-sanitized tool profile cache + per-message tool-profile picker.
// Avoids re-sanitizing 46+ schemas per message. Cache is intentionally never
// invalidated: EVERYONE_TOOLS / OWNER_TOOLS are static module imports, so the
// tool list is pinned at module load. If tools ever become dynamic at
// runtime, this cache must be reset accordingly.

import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";
import { toGeminiTools, looksLikeTask } from "../../ai/providers/index.js";
import { ACTIVITY_TOOLS_SET, ACTIVITY_KEYWORDS_RX } from "./constants.js";

let _cachedGeminiTools = null;
let _twinTools, _chatTools, _chatToolsOwner, _allTools, _allToolsOwner;

function ensureCache() {
  if (_cachedGeminiTools) return;
  // Build cached profiles on first hit.
  // Twin profile membership is metadata-driven — tools opt in by adding
  // "fun" to their `tags` array in ai/tools.js. No hardcoded name list.
  _twinTools = EVERYONE_TOOLS.filter(t => t.tags?.includes("fun"));
  _chatTools = EVERYONE_TOOLS.filter(t => !ACTIVITY_TOOLS_SET.has(t.name));
  _chatToolsOwner = [...EVERYONE_TOOLS, ...OWNER_TOOLS].filter(t => !ACTIVITY_TOOLS_SET.has(t.name));
  _allTools = [...EVERYONE_TOOLS];
  _allToolsOwner = [...EVERYONE_TOOLS, ...OWNER_TOOLS];
  // Pre-sanitize all profiles (WeakMap cache in toGeminiTools)
  _cachedGeminiTools = {
    twin: toGeminiTools(_twinTools),
    chat: toGeminiTools(_chatTools),
    chatOwner: toGeminiTools(_chatToolsOwner),
    full: toGeminiTools(_allTools),
    fullOwner: toGeminiTools(_allToolsOwner),
  };
}

/**
 * Pick the active tool profile for this turn.
 * Logic preserved verbatim from the inline code in messageCreate.js — twin
 * messages always get the trimmed "fun"-tag profile; non-twin messages get
 * the activity-heavy "full" profile when the message looks task-like, and
 * the chat-only profile (activity tools filtered out) otherwise. Owner adds
 * OWNER_TOOLS to whichever bucket they land in.
 *
 * @param {object} opts
 * @param {boolean} opts.isTwinMsg
 * @param {boolean} opts.isOwner
 * @param {string}  opts.cleanMessage
 * @returns {{ allTools: object[], formattedTools: object }}
 */
export function pickToolProfile({ isTwinMsg, isOwner, cleanMessage }) {
  ensureCache();
  let allTools, formattedTools;
  if (isTwinMsg) {
    allTools = _twinTools;
    formattedTools = _cachedGeminiTools.twin;
  } else {
    const isTask = looksLikeTask(cleanMessage) || ACTIVITY_KEYWORDS_RX.test(cleanMessage);
    if (isTask) {
      allTools = isOwner ? _allToolsOwner : _allTools;
      formattedTools = isOwner ? _cachedGeminiTools.fullOwner : _cachedGeminiTools.full;
    } else {
      allTools = isOwner ? _chatToolsOwner : _chatTools;
      formattedTools = isOwner ? _cachedGeminiTools.chatOwner : _cachedGeminiTools.chat;
    }
  }
  return { allTools, formattedTools };
}
