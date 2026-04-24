import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";
import { categorizeRole } from "@defnotean/shared/roleCategorizer";

export const name = "roleUpdate";

// Humanize Discord's PascalCase permission names
function humanPerm(p) {
  return p.replace(/([A-Z])/g, " $1").trim();
}

// Flag permissions that materially increase attack surface — these should jump
// out in the log so admins notice when someone bumps a role up.
const DANGEROUS_PERMS = new Set([
  "Administrator", "ManageGuild", "ManageRoles", "ManageChannels",
  "ManageWebhooks", "BanMembers", "KickMembers", "ModerateMembers",
  "ManageMessages", "MentionEveryone", "ViewAuditLog", "ManageEmojisAndStickers",
]);

export async function execute(oldRole, newRole) {
  const beforeLines = [];
  const afterLines = [];
  const changedKeys = [];

  if (oldRole.name !== newRole.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`${oldRole.name}\``);
    afterLines.push(`**Name** · \`${newRole.name}\``);
  }
  if (oldRole.hexColor !== newRole.hexColor) {
    changedKeys.push("Color");
    beforeLines.push(`**Color** · \`${oldRole.hexColor}\``);
    afterLines.push(`**Color** · \`${newRole.hexColor}\``);
  }
  if (oldRole.hoist !== newRole.hoist) {
    changedKeys.push("Hoist");
    beforeLines.push(`**Hoisted** · ${oldRole.hoist ? "✅ yes" : "❌ no"}`);
    afterLines.push(`**Hoisted** · ${newRole.hoist ? "✅ yes" : "❌ no"}`);
  }
  if (oldRole.mentionable !== newRole.mentionable) {
    changedKeys.push("Mentionable");
    beforeLines.push(`**Mentionable** · ${oldRole.mentionable ? "✅ yes" : "❌ no"}`);
    afterLines.push(`**Mentionable** · ${newRole.mentionable ? "✅ yes" : "❌ no"}`);
  }
  if (oldRole.position !== newRole.position) {
    changedKeys.push("Position");
    beforeLines.push(`**Position** · ${oldRole.position}`);
    afterLines.push(`**Position** · ${newRole.position}`);
  }

  // Permission diff — called out separately with danger flagging
  let permFields = [];
  let dangerEscalation = false;
  if (!oldRole.permissions.equals(newRole.permissions)) {
    changedKeys.push("Permissions");
    const added = newRole.permissions.toArray().filter((p) => !oldRole.permissions.has(p));
    const removed = oldRole.permissions.toArray().filter((p) => !newRole.permissions.has(p));
    const addedDangerous = added.filter((p) => DANGEROUS_PERMS.has(p));
    dangerEscalation = addedDangerous.length > 0;

    if (added.length) {
      const label = addedDangerous.length ? `⚠️ Granted (${added.length})` : `✅ Granted (${added.length})`;
      permFields.push({
        name: label,
        value: added.map((p) => {
          const name = humanPerm(p);
          return DANGEROUS_PERMS.has(p) ? `**⚠️ ${name}**` : name;
        }).join("\n").slice(0, 1024),
        inline: true,
      });
    }
    if (removed.length) {
      permFields.push({
        name: `❌ Revoked (${removed.length})`,
        value: removed.map((p) => humanPerm(p)).join("\n").slice(0, 1024),
        inline: true,
      });
    }
  }

  // Category shift — derived from the permission bitfield, not the name.
  // Surface it separately so admins see exactly how the role's *effective*
  // tier changed (e.g. "cosmetic → moderator" when they add BanMembers),
  // which is what downstream systems (like tickets' auto-category) key off.
  const oldCat = categorizeRole(oldRole, oldRole.guild);
  const newCat = categorizeRole(newRole, newRole.guild);
  const categoryShifted = oldCat !== newCat;
  if (categoryShifted) changedKeys.push("Category");

  if (!changedKeys.length) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newRole.guild.fetchAuditLogs({ type: 31, limit: 1 }); // ROLE_UPDATE
    const entry = audit.entries.first();
    if (entry && entry.target?.id === newRole.id && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const diffFields = beforeLines.length
    ? [
        { name: "📋 Before", value: beforeLines.join("\n") || "*(unchanged)*", inline: true },
        { name: "📝 After",  value: afterLines.join("\n")  || "*(unchanged)*", inline: true },
      ]
    : [];

  const categoryNote = categoryShifted
    ? `\n\n🏷️ **Category shift** · \`${oldCat}\` → \`${newCat}\` (this is what auto-mod/ticket flows use to decide who counts as staff)`
    : "";

  await sendModLog(newRole.guild, logEvent({
    kind: "roleUpdate",
    actor,
    reason: reason || undefined,
    description: `Role <@&${newRole.id}> was updated${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.${dangerEscalation ? "\n\n⚠️ **Dangerous permission(s) added** — review below." : ""}${categoryNote}`,
    meta: {
      "Role": `<@&${newRole.id}> · \`${newRole.name}\``,
      "Members with Role": newRole.members?.size != null ? String(newRole.members.size) : null,
      "Color": newRole.hexColor !== "#000000" ? `\`${newRole.hexColor}\`` : null,
      "Category": categoryShifted ? `\`${oldCat}\` → \`${newCat}\`` : `\`${newCat}\``,
    },
    fields: [...diffFields, ...permFields],
    footerNote: `Role ID: ${newRole.id}`,
  }));
}
