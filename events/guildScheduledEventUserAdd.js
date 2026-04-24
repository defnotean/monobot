import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";

export const name = "guildScheduledEventUserAdd";

export async function execute(event, user) {
  const embed = modEmbed("📅 Event RSVP", `**${user.tag}** is interested in **${event.name}**`)
    .setFooter({ text: `User ID: ${user.id}` });
  await sendModLog(event.guild, embed);
}
