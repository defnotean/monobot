// ─── Reaction Handler — Catchphrase Tracking ───────────────────────────────
// When someone reacts to one of Eris's messages with a popular emoji,
// track that phrase as a potential catchphrase. If it gets 3+ reactions,
// the personality system will occasionally reuse it.

import { log } from "../utils/logger.js";

// Reaction emojis that indicate "this was good"
const GOOD_REACTIONS = new Set(["❤️", "😂", "🔥", "💀", "😭", "👍", "💯", "⭐", "🤣", "❤️‍🔥", "🫡"]);

export default async function messageReactionAdd(reaction, user) {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partials if needed
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }

  // Only track reactions to OUR messages (use guild.members.me to find bot)
  const botId = reaction.message.guild?.members?.me?.id;
  if (!botId || reaction.message.author?.id !== botId) return;

  // Only track "good" reactions
  const emoji = reaction.emoji.name;
  if (!GOOD_REACTIONS.has(emoji)) return;

  // Don't track very long messages or empty ones
  const content = reaction.message.content;
  if (!content || content.length < 5 || content.length > 120) return;

  // Track as potential catchphrase
  try {
    const { trackCatchphrase } = await import("../ai/personality.js");
    await trackCatchphrase(content, emoji);
    log(`[Catchphrase] Tracked reaction ${emoji} on: "${content.substring(0, 50)}"`);
  } catch (e) {
    log(`[Catchphrase] Error: ${e.message}`);
  }
}
