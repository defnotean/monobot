import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { guildInvites } from "../utils/invites.js";

export const name = "inviteDelete";

export async function execute(invite) {
  if (!invite.guild) return;

  // Pull the cached inviter (if we had one) BEFORE purging the cache entry
  const cached = guildInvites.get(invite.guild.id);
  const cachedData = cached?.get(invite.code) || null;
  if (cached) cached.delete(invite.code);

  // Audit log for invite deletion
  let actor = null;
  let reason = null;
  try {
    const audit = await invite.guild.fetchAuditLogs({ type: 42, limit: 1 }); // INVITE_DELETE
    const entry = audit.entries.first();
    if (entry && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  await sendModLog(invite.guild, logEvent({
    kind: "audit",
    title: "Invite Deleted",
    actor,
    reason: reason || undefined,
    description: `Invite \`${invite.code}\` was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta: {
      "Code": `\`${invite.code}\``,
      "Channel": invite.channel ? `<#${invite.channel.id}> · \`${invite.channel.name}\`` : null,
      "Was Created By": cachedData?.inviter
        ? `<@${cachedData.inviter.id}> · \`${cachedData.inviter.tag}\`${cachedData.inviter.bot ? " 🤖" : ""}`
        : null,
      "Uses at Deletion": cachedData?.uses != null ? String(cachedData.uses) : null,
      "Deleted By": actor
        ? `<@${actor.id}> · \`${actor.tag}\`${actor.bot ? " 🤖" : ""}`
        : "*(unknown or expired naturally)*",
    },
    color: 0xed4245,
    footerNote: `Invite: ${invite.code}`,
  }));
}
