import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";
import { getReactionRoles, isReactionRoleExclusive } from "../database.js";
import { log } from "../utils/logger.js";

// Track reactions being removed by the bot (exclusive mode) to avoid race conditions
export const _botRemovedReactions = new Set();

export const name = "messageReactionRemove";

export async function execute(reaction, user) {
  if (!reaction.message.guild || user.bot) return;
  await Promise.all([
    reaction.partial ? reaction.fetch().catch(() => {}) : null,
    reaction.message.partial ? reaction.message.fetch().catch(() => {}) : null,
  ]);

  const guild = reaction.message.guild;

  // ── Reaction Roles — remove (Feature 18) ─────────────────────────────────
  const reactionRoles = getReactionRoles(guild.id, reaction.message.id);
  if (reactionRoles.length > 0) {
    const emojiStr = reaction.emoji.id
      ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
      : reaction.emoji.name;

    const match = reactionRoles.find((r) => r.emoji === emojiStr || r.emoji === reaction.emoji.name);
    if (match) {
      // In exclusive mode, the bot removes other reactions automatically.
      // Don't remove the role if the bot did the removal (it's switching, not unassigning).
      const exclusive = isReactionRoleExclusive(guild.id, reaction.message.id);
      const skipKey = `${reaction.message.id}:${user.id}:${reaction.emoji.name}`;
      if (exclusive && _botRemovedReactions.has(skipKey)) {
        _botRemovedReactions.delete(skipKey);
        return; // Bot removed this reaction for exclusive switch — don't remove the role
      }

      try {
        const member = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id);
        const role = guild.roles.cache.get(match.roleId);
        if (role && member) {
          await member.roles.remove(role, "Reaction role removed");
          log(`[ReactionRole] Removed "${role.name}" from ${user.tag}`);
        }
      } catch (err) {
        log(`[ReactionRole] Failed to remove role: ${err.message}`);
      }
    }
  }

  const embed = modEmbed(
    "💬 Reaction Removed",
    `**${user.tag}** removed reaction ${reaction.emoji} from a message in <#${reaction.message.channel.id}>\n[Jump to message](${reaction.message.url})`
  ).setFooter({ text: `User ID: ${user.id}` });

  await sendModLog(guild, embed);
}
