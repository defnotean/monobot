import { sendModLog, log } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { trackAction } from "../utils/antinuke.js";

export const name = "roleDelete";

export async function execute(role) {
  let actor = null;
  let reason = null;
  try {
    const audit = await role.guild.fetchAuditLogs({ type: 32, limit: 1 }); // ROLE_DELETE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === role.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  // Figure out how many members had this role (best-effort — cache may not be complete)
  const memberCount = role.members?.size ?? 0;
  const ageMs = role.createdTimestamp ? Date.now() - role.createdTimestamp : null;
  const ageDays = ageMs !== null ? Math.floor(ageMs / 86_400_000) : null;

  const perms = role.permissions;
  const hadAdmin = perms.has("Administrator");

  const meta = {
    "Role": `\`${role.name}\` · \`${role.id}\``,
    "Color": role.hexColor !== "#000000" ? `\`${role.hexColor}\`` : null,
    "Members Affected": memberCount > 0 ? `⚠️ ${memberCount} members` : "0 (role was empty)",
    "Position": String(role.position),
    "Created": role.createdTimestamp ? `<t:${Math.floor(role.createdTimestamp / 1000)}:R>` : null,
    "Age": ageDays !== null ? `${ageDays}d` : null,
    "Was Admin": hadAdmin ? "⚠️ yes" : null,
    "Managed": role.managed ? "yes (integration role)" : null,
  };

  await sendModLog(role.guild, logEvent({
    kind: "roleDelete",
    actor,
    reason: reason || undefined,
    description: `Role \`${role.name}\` was deleted${actor ? ` by <@${actor.id}>` : ""}.`,
    meta,
    color: 0xED4245,
    footerNote: `Role ID: ${role.id}`,
  }));

  // Anti-nuke tracking
  if (actor && actor.id !== role.guild.client.user.id) {
    try { trackAction(role.guild.id, actor.id, "role_delete", role.guild).catch(() => {}); } catch {}
  }
}
