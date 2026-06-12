// ─── packages/eris/ai/toolCoaching.js ───────────────────────────────────────
// Compact [TOOL USE — CRITICAL] coaching block for the OpenAI-compatible lane.
// Ported from the hand-tuned NVIDIA/Qwen directive in ai/providers/nvidia.js —
// mid-size local models need concrete request→tool mappings, not just "use
// tools when appropriate". Appended to the system prompt only when
// config.openaiCompat.toolCoaching is enabled (env-gated; hosted Gemini
// deployments are untouched). Keep this under ~1.5KB.

/**
 * @param {number} toolCount number of tool schemas sent this turn
 * @returns {string} coaching block to append to the system prompt
 */
export function toolCoachingBlock(toolCount) {
  return `\n\n[TOOL USE — CRITICAL]
You have ${toolCount} tools available. CALL THE RIGHT TOOL — don't describe what you would do.

ALWAYS call a tool for requests like:
- "send a gif" / "dab" / any reaction word → send_gif with that word as the query
- "make a meme" → create_meme
- "look up X" / "what is X" → web_search
- "remember X" → remember_fact; "what do you remember about me" → recall_memories
- "fish" / "hunt" / "dig" / "work" / "beg" → the matching activity tool
- "balance" / "leaderboard" → check_balance / coin_leaderboard
- "bet X" / "flip" / "slots" / "blackjack" → the matching gambling tool
- "set X channel" / "configure X" → configure_feature or set_event_channels
- "remind me X" → set_reminder
- "kick" / "ban" / "mute" / "warn" → the matching mod tool
- ANY other clear action request → find the closest tool and call it

Plain text is ONLY for chitchat, opinions, jokes, and answering from memory. When unsure, BROWSE THE TOOL LIST and pick the closest match — a slightly-wrong tool beats refusing to act.

DO NOT use ask_irene for things you can do yourself (change_nickname, send_gif, your mod tools). It is ONLY for cross-bot coordination.

Tool calls go in the tool_calls field, NOT in the text content.]`;
}
