import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";
import { EmbedBuilder } from "discord.js";
import { getReactionRoles, isReactionRoleExclusive, getStarboard, addStarboardEntry, getStarboardEntry } from "../database.js";
import { _botRemovedReactions } from "./messageReactionRemove.js";
import { log } from "../utils/logger.js";
import { validateAssignableRole } from "../ai/executors/customCommandExecutor.js";

export const name = "messageReactionAdd";

export async function execute(reaction, user) {
  if (!reaction.message.guild || user.bot) return;
  // Fetch partials in parallel if needed
  await Promise.all([
    reaction.partial ? reaction.fetch().catch(() => {}) : null,
    reaction.message.partial ? reaction.message.fetch().catch(() => {}) : null,
  ]);

  const guild = reaction.message.guild;

  // ── Reaction Roles (Feature 18) ──────────────────────────────────────────
  const reactionRoles = getReactionRoles(guild.id, reaction.message.id);
  if (reactionRoles.length > 0) {
    const emojiStr = reaction.emoji.id
      ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
      : reaction.emoji.name;

    const match = reactionRoles.find((r) => r.emoji === emojiStr || r.emoji === reaction.emoji.name);
    if (match) {
      try {
        // Use cache first, only fetch from API if not cached
        const member = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id);
        const role = guild.roles.cache.get(match.roleId);
        if (role && member) {
          const roleErr = validateAssignableRole(guild, role, { actor: member, actionLabel: "Reaction role" });
          if (roleErr) {
            log(`[ReactionRole] blocked unsafe role ${match.roleId} for ${user.tag}: ${roleErr}`);
            return;
          }
          const exclusive = isReactionRoleExclusive(guild.id, reaction.message.id);

          if (exclusive) {
            // Mark all other reactions as bot-removed FIRST (before any awaits)
            for (const [, msgReaction] of reaction.message.reactions.cache) {
              if (msgReaction.emoji.name === reaction.emoji.name) continue;
              const skipKey = `${reaction.message.id}:${user.id}:${msgReaction.emoji.name}`;
              _botRemovedReactions.add(skipKey);
              setTimeout(() => _botRemovedReactions.delete(skipKey), 10_000);
            }

            // Run ALL operations in parallel: add new role + remove old roles + remove old reactions
            const ops = [];

            // Add the new role
            ops.push(member.roles.add(role, "Reaction role"));

            // Remove old roles
            for (const rr of reactionRoles) {
              if (rr.emoji === emojiStr || rr.emoji === reaction.emoji.name) continue;
              const otherRole = guild.roles.cache.get(rr.roleId);
              if (otherRole && member.roles.cache.has(otherRole.id)) {
                ops.push(member.roles.remove(otherRole, "Exclusive switch").catch(() => {}));
              }
            }

            // Remove other reactions
            for (const [, msgReaction] of reaction.message.reactions.cache) {
              if (msgReaction.emoji.name === reaction.emoji.name) continue;
              ops.push(msgReaction.users.remove(user.id).catch(() => {}));
            }

            await Promise.allSettled(ops);
          } else {
            await member.roles.add(role, "Reaction role");
          }

          log(`[ReactionRole] Gave "${role.name}" to ${user.tag}${exclusive ? " (exclusive)" : ""}`);
        }
      } catch (err) {
        log(`[ReactionRole] Failed: ${err.message}`);
      }
    }
  }

  // ── Starboard (Feature 20) ───────────────────────────────────────────────
  if (reaction.emoji.name === "⭐") {
    const starboard = getStarboard(guild.id);
    if (starboard.channelId) {
      const starChannel = guild.channels.cache.get(starboard.channelId);
      if (!starChannel) return;

      // Don't star messages in the starboard channel itself
      if (reaction.message.channel.id === starboard.channelId) return;

      const starCount = reaction.count;

      if (starCount >= starboard.threshold) {
        const existingId = getStarboardEntry(guild.id, reaction.message.id);

        const originalMsg = reaction.message;
        const author = originalMsg.author;
        const starEmbed = new EmbedBuilder()
          .setColor(0xffd700)
          .setAuthor({ name: author.tag, iconURL: author.displayAvatarURL() })
          .setDescription(originalMsg.content || null)
          .addFields(
            { name: "Source", value: `[Jump to message](${originalMsg.url})`, inline: true },
            { name: "Channel", value: `<#${originalMsg.channel.id}>`, inline: true },
          )
          .setTimestamp(originalMsg.createdAt)
          .setFooter({ text: `⭐ ${starCount}` });

        // Attach image if present
        const image = originalMsg.attachments.find((a) => a.contentType?.startsWith("image/"));
        if (image) starEmbed.setImage(image.url);
        else if (!originalMsg.content && originalMsg.embeds[0]?.image) {
          starEmbed.setImage(originalMsg.embeds[0].image.url);
        }

        if (existingId) {
          // Update existing starboard message
          try {
            const starMsg = await starChannel.messages.fetch(existingId).catch(() => null);
            if (starMsg) await starMsg.edit({ content: `⭐ **${starCount}**`, embeds: [starEmbed] });
          } catch (err) {
            log(`[Starboard] Failed to update: ${err.message}`);
          }
        } else {
          // Post new starboard entry
          try {
            const starMsg = await starChannel.send({ content: `⭐ **${starCount}**`, embeds: [starEmbed] });
            addStarboardEntry(guild.id, reaction.message.id, starMsg.id);
          } catch (err) {
            log(`[Starboard] Failed to post: ${err.message}`);
          }
        }
      }
    }
  }

  // ── Catchphrase tracking (personality learning) ──────────────────────────
  // When someone reacts to Irene's messages with a "good" emoji, track the phrase
  const GOOD_REACTIONS = new Set(["❤️", "😂", "🔥", "💀", "😭", "👍", "💯", "⭐", "🤣", "❤️‍🔥", "🫡"]);
  if (reaction.message.author?.id === reaction.message.guild?.members?.me?.id && GOOD_REACTIONS.has(reaction.emoji.name)) {
    const content = reaction.message.content;
    if (content && content.length >= 5 && content.length <= 120) {
      try {
        const { trackCatchphrase } = await import("../ai/personality.js");
        await trackCatchphrase(content, reaction.emoji.name);
      } catch {}
    }
  }

  // ── Log reaction (existing behavior) ────────────────────────────────────
  const embed = modEmbed(
    "💬 Reaction Added",
    `**${user.tag}** reacted ${reaction.emoji} to a message in <#${reaction.message.channel.id}>\n[Jump to message](${reaction.message.url})`
  ).setFooter({ text: `User ID: ${user.id}` });

  await sendModLog(guild, embed);
}
