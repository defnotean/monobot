import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";

export const name = "guildScheduledEventUserRemove";

export async function execute(event, user) {
  const embed = modEmbed("📅 Event Un-RSVP", `**${user.tag}** is no longer interested in **${event.name}**`)
    .setFooter({ text: `User ID: ${user.id}` });
  await sendModLog(event.guild, embed);
}
