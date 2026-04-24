import { sendModLog } from "../utils/logger.js";
import { logEmbed, LC } from "../utils/embeds.js";
import { cacheEditedMessage } from "../utils/snipe.js";

export const name = "messageUpdate";

export async function execute(oldMessage, newMessage) {
  if (!newMessage.guild) return;

  // Partial = evicted from cache. Fetch the full message — it still exists since it was edited.
  if (newMessage.partial) {
    try {
      newMessage = await newMessage.fetch();
    } catch {
      return; // genuinely unavailable
    }
  }

  if (!newMessage.author || newMessage.author.bot) return;
  if (oldMessage.content === newMessage.content) return;

  // Cache edit for edit-snipe (before filtering for mod log)
  cacheEditedMessage(oldMessage, newMessage);

  const before = oldMessage.partial ? "*uncached pre-edit*" : (oldMessage.content?.slice(0, 900) || "*empty*");
  const after = newMessage.content?.slice(0, 900) || "*empty*";

  const embed = logEmbed("Message Edited", LC.message)
    .setAuthor({ name: newMessage.author?.tag ?? "Unknown User", iconURL: newMessage.author?.displayAvatarURL() })
    .setThumbnail(newMessage.author?.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "Author", value: newMessage.author ? `<@${newMessage.author.id}>` : "unknown", inline: true },
      { name: "Channel", value: `<#${newMessage.channel.id}>`, inline: true },
      { name: "Jump to Message", value: `[View](${newMessage.url})`, inline: true },
      { name: "Before", value: before },
      { name: "After", value: after },
    )
    .setFooter({ text: `Message ID: ${newMessage.id}` });

  await sendModLog(newMessage.guild, embed);
}
