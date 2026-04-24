import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { tempTextChannels } from "../utils/tempvc.js";

export const name = "channelPinsUpdate";

export async function execute(channel, time) {
  if (!channel.guild) return;
  // Skip pin events in temp VC text channels (bot pins its own control panel)
  if ([...tempTextChannels.values()].includes(channel.id)) return;

  // Try to identify WHO pinned/unpinned the message. Discord fires audit
  // entries 74 (MESSAGE_PIN) and 75 (MESSAGE_UNPIN) so we try both.
  let actor = null;
  let action = "changed";
  let targetMessageId = null;
  try {
    const [pinAudit, unpinAudit] = await Promise.all([
      channel.guild.fetchAuditLogs({ type: 74, limit: 1 }).catch(() => null), // MESSAGE_PIN
      channel.guild.fetchAuditLogs({ type: 75, limit: 1 }).catch(() => null), // MESSAGE_UNPIN
    ]);
    const pinEntry = pinAudit?.entries?.first();
    const unpinEntry = unpinAudit?.entries?.first();

    const pinRecent = pinEntry && Date.now() - pinEntry.createdTimestamp < 5000;
    const unpinRecent = unpinEntry && Date.now() - unpinEntry.createdTimestamp < 5000;

    // Whichever fired most recently (and within the window) is the cause
    if (pinRecent && unpinRecent) {
      const pinCloser = pinEntry.createdTimestamp > unpinEntry.createdTimestamp;
      const picked = pinCloser ? pinEntry : unpinEntry;
      actor = picked.executor;
      action = pinCloser ? "pinned" : "unpinned";
      targetMessageId = picked.extra?.messageId ?? picked.target?.id ?? null;
    } else if (pinRecent) {
      actor = pinEntry.executor;
      action = "pinned";
      targetMessageId = pinEntry.extra?.messageId ?? pinEntry.target?.id ?? null;
    } else if (unpinRecent) {
      actor = unpinEntry.executor;
      action = "unpinned";
      targetMessageId = unpinEntry.extra?.messageId ?? unpinEntry.target?.id ?? null;
    }
  } catch {}

  const jumpLink = targetMessageId
    ? `https://discord.com/channels/${channel.guild.id}/${channel.id}/${targetMessageId}`
    : null;

  await sendModLog(channel.guild, logEvent({
    kind: action === "pinned" ? "pin" : action === "unpinned" ? "unpin" : "audit",
    title: action === "pinned" ? "Message Pinned"
         : action === "unpinned" ? "Message Unpinned"
         : "Pins Updated",
    actor,
    description: actor
      ? `<@${actor.id}> ${action} a message in <#${channel.id}>.`
      : `Pinned messages changed in <#${channel.id}>.`,
    meta: {
      "Channel": `<#${channel.id}> · \`${channel.name}\``,
      "Action": action,
      "Message": targetMessageId ? `\`${targetMessageId}\`${jumpLink ? ` · [jump](${jumpLink})` : ""}` : null,
      "Moderator": actor ? `<@${actor.id}> · \`${actor.tag}\`${actor.bot ? " 🤖" : ""}` : "*(unknown)*",
    },
    footerNote: `Channel ID: ${channel.id}`,
  }));
}
