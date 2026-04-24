import { sendModLog } from "../utils/logger.js";
import { logEmbed, LC } from "../utils/embeds.js";

export const name = "messageDeleteBulk";

export async function execute(messages, channel) {
  if (!channel.guild) return;

  let moderator = null;
  try {
    const audit = await channel.guild.fetchAuditLogs({ type: 73, limit: 1 });
    const entry = audit.entries.first();
    if (entry && Date.now() - entry.createdTimestamp < 5000) {
      moderator = entry.executor?.tag;
    }
  } catch {}

  const embed = logEmbed("Bulk Messages Deleted", LC.message)
    .addFields(
      { name: "Channel", value: `<#${channel.id}>`, inline: true },
      { name: "Messages Deleted", value: String(messages.size), inline: true },
      { name: "Deleted By", value: moderator ?? "unknown", inline: true },
    )
    .setFooter({ text: `Channel ID: ${channel.id}` });

  await sendModLog(channel.guild, embed);
}
