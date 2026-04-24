import { sendModLog } from "../utils/logger.js";
import { modEmbed } from "../utils/embeds.js";

export const name = "guildAuditLogEntryCreate";

// Action types we log here — things not already covered by dedicated events
const TRACKED = {
  50: "Webhook Created",
  51: "Webhook Updated",
  52: "Webhook Deleted",
  60: null, // emoji — handled by emojiCreate
  72: null, // handled by channelPinsUpdate
  73: null, // bulk delete — handled by messageBulkDelete
  80: "Integration Created",
  81: "Integration Updated",
  82: "Integration Deleted",
  83: "Stage Instance Created",
  84: "Stage Instance Updated",
  85: "Stage Instance Deleted",
  121: "Auto-Mod Rule Created",
  122: "Auto-Mod Rule Updated",
  123: "Auto-Mod Rule Deleted",
};

export async function execute(entry, guild) {
  const label = TRACKED[entry.action];
  if (!label) return; // not tracked or handled elsewhere

  const executor = entry.executor ? `by **${entry.executor.tag}**` : "";
  const target = entry.target?.name ?? entry.target?.tag ?? entry.targetId ?? "";
  const reason = entry.reason ? `\n**Reason:** ${entry.reason}` : "";

  const embed = modEmbed(
    `📋 ${label}`,
    [`${target}`, executor, reason].filter(Boolean).join(" ") || label
  ).setFooter({ text: `Action #${entry.action}` });

  await sendModLog(guild, embed);
}
