import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";

export const name = "messageReactionRemoveEmoji";

export async function execute(reaction) {
  if (!reaction.message.guild) return;
  if (reaction.message.partial) { try { await reaction.message.fetch(); } catch { return; } }

  const embed = modEmbed(
    "💬 Emoji Reaction Wiped",
    `All ${reaction.emoji} reactions were removed from a message in <#${reaction.message.channel.id}>\n[Jump to message](${reaction.message.url})`
  );

  await sendModLog(reaction.message.guild, embed);
}
