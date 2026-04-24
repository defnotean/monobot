import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { categorizeRole } from "../utils/roleCategorizer.js";

export const name = "roleCreate";

export async function execute(role) {
  let actor = null;
  let reason = null;
  try {
    const audit = await role.guild.fetchAuditLogs({ type: 30, limit: 1 }); // ROLE_CREATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === role.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  // Summarize notable permissions so admins don't have to dig through Discord UI
  const perms = role.permissions;
  const notable = [];
  if (perms.has("Administrator")) notable.push("⚠️ Administrator");
  if (perms.has("ManageGuild")) notable.push("Manage Server");
  if (perms.has("ManageRoles")) notable.push("Manage Roles");
  if (perms.has("ManageChannels")) notable.push("Manage Channels");
  if (perms.has("BanMembers")) notable.push("Ban Members");
  if (perms.has("KickMembers")) notable.push("Kick Members");
  if (perms.has("ModerateMembers")) notable.push("Timeout Members");
  if (perms.has("ManageMessages")) notable.push("Manage Messages");
  if (perms.has("MentionEveryone")) notable.push("Mention @everyone");

  // Permission-based category — so auto-mod/ticket flows treat this role
  // the right way from day one without waiting for someone to re-run setup.
  const category = categorizeRole(role, role.guild);

  const meta = {
    "Role": `<@&${role.id}> · \`${role.name}\``,
    "Category": `\`${category}\``,
    "Color": role.hexColor !== "#000000" ? `\`${role.hexColor}\`` : "*(default)*",
    "Hoisted": role.hoist ? "✅ shown separately" : null,
    "Mentionable": role.mentionable ? "✅ anyone can mention" : null,
    "Position": String(role.position),
    "Managed": role.managed ? `yes (by ${role.tags?.botId ? "bot integration" : role.tags?.integrationId ? "integration" : "system"})` : null,
    "Dangerous Perms": notable.length ? notable.join(", ") : null,
  };

  await sendModLog(role.guild, logEvent({
    kind: "roleCreate",
    actor,
    reason: reason || undefined,
    description: `Role <@&${role.id}> was created${actor ? ` by <@${actor.id}>` : ""}.`,
    meta,
    footerNote: `Role ID: ${role.id}`,
  }));
}
