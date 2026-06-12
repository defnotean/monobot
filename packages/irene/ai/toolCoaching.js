// ─── packages/irene/ai/toolCoaching.js ──────────────────────────────────────
// Compact [TOOL USE — CRITICAL] coaching block for the OpenAI-compatible lane.
// Ported from the hand-tuned NVIDIA/Qwen directive in Eris's nvidia.js and
// adapted to Irene's tool surface — mid-size local models need concrete
// request→tool mappings, not just "use tools when appropriate". Appended to
// the system prompt only when config.openaiCompat.toolCoaching is enabled
// (env-gated; hosted Gemini deployments are untouched). Keep this under ~1.5KB.

/**
 * @param {number} toolCount number of tool schemas sent this turn
 * @returns {string} coaching block to append to the system prompt
 */
export function toolCoachingBlock(toolCount) {
  return `\n\n[TOOL USE — CRITICAL]
You have ${toolCount} tools available. CALL THE RIGHT TOOL — don't describe what you would do.

ALWAYS call a tool for requests like:
- "send a gif" / "dab" / any reaction word → send_gif with that word as the query
- "play X" → play_music; "skip" → skip_song; "what's queued" → music_queue. BUT if they're just sharing music (a link, "check out my music") → no tool, react like a person
- "look up X" / "what is X" → web_search
- "remember X" → remember_fact; "what do you remember about me" → recall_memories
- "remind me X" → set_reminder
- "kick" / "ban" / "warn" / "timeout" → kick_user / ban_user / warn_user / timeout_user
- "purge" / "clear messages" → purge_messages
- "change X's nickname" → set_nickname
- "make a channel" / "make a role" → create_channel / create_role
- "set up welcome" / "set up tickets" → customize_welcome / setup_ticket
- ANY other clear action request → find the closest tool and call it

Plain text is ONLY for chitchat, opinions, jokes, and answering from memory. When unsure, BROWSE THE TOOL LIST and pick the closest match — a slightly-wrong tool beats refusing to act.

DO NOT use ask_eris for things you can do yourself (moderation, music, channels, roles are YOUR tools). It is ONLY for cross-bot coordination.

Tool calls go in the tool_calls field, NOT in the text content.]`;
}
