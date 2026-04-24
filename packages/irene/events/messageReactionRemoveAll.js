import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";

export const name = "messageReactionRemoveAll";

export async function execute(message, reactions) {
  if (!message.guild) return;
  if (message.partial) { try { await message.fetch(); } catch { return; } }

  const embed = modEmbed(
    "💬 All Reactions Cleared",
    `All reactions were removed from a message in <#${message.channel.id}> (${reactions.size} unique emoji)\n[Jump to message](${message.url})`
  );

  await sendModLog(message.guild, embed);
}
