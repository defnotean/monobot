import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { guildInvites } from "../utils/invites.js";

export const name = "inviteCreate";

export async function execute(invite) {
  if (!invite.guild) return;

  // Update invite cache (Feature 6)
  const cached = guildInvites.get(invite.guild.id);
  if (cached) {
    cached.set(invite.code, {
      uses: invite.uses ?? 0,
      inviter: invite.inviter,
      channel: invite.channel,
      maxUses: invite.maxUses,
    });
  }

  const expiresAt = invite.maxAge === 0 ? null : Date.now() + invite.maxAge * 1000;

  await sendModLog(invite.guild, logEvent({
    kind: "audit",
    title: "Invite Created",
    actor: invite.inviter,
    description: invite.inviter
      ? `<@${invite.inviter.id}> created invite \`${invite.code}\` for <#${invite.channel?.id}>.`
      : `Invite \`${invite.code}\` was created for <#${invite.channel?.id}>.`,
    meta: {
      "Code": `\`${invite.code}\` · https://discord.gg/${invite.code}`,
      "Created By": invite.inviter
        ? `<@${invite.inviter.id}> · \`${invite.inviter.tag}\`${invite.inviter.bot ? " 🤖" : ""}`
        : "*(unknown — maybe vanity URL)*",
      "Channel": invite.channel ? `<#${invite.channel.id}> · \`${invite.channel.name}\`` : "*(unknown)*",
      "Max Uses": invite.maxUses === 0 ? "unlimited" : String(invite.maxUses),
      "Expires": expiresAt ? `<t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>)` : "never",
      "Temporary": invite.temporary ? "✅ yes (kicks on disconnect if no role)" : null,
      "Target Type": invite.targetType ? String(invite.targetType) : null,
    },
    color: 0x57f287, // green for create
    footerNote: `Invite: ${invite.code}`,
  }));
}
