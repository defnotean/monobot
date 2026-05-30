// @ts-check
/**
 * @file packages/irene/ai/hierarchy.js
 *
 * Role-hierarchy / moderation permission gates for Irene's AI executor.
 * Extracted verbatim from executor.js as part of the barrel-split — behavior is
 * identical. Both checks are passed into the sub-executor `ctx` so the
 * moderation/role domains share one definition.
 *
 *  - checkHierarchy     — strict gate for ban/kick/timeout/warn/nickname: refuse
 *    the owner, self-target, and any target ranked >= the moderator.
 *  - checkRoleAssignment — smarter gate for role give/remove: permits harmless
 *    self-assignment but blocks elevated-permission roles and cross-user edits
 *    that violate the hierarchy.
 */

import { PermissionFlagsBits } from "discord.js";

// Strict hierarchy check for moderation actions (ban, kick, timeout, warn, nickname)
export function checkHierarchy(moderator, target, guild) {
  if (!moderator) return "Could not verify moderator permissions — member not found";
  if (target.id === guild.ownerId) return `Can't do that to the server owner`;
  if (target.id === moderator.id) return `Can't do that to yourself`;
  if (moderator.id === guild.ownerId) return null;
  const modTop = moderator.roles.highest.position;
  const targetTop = target.roles.highest.position;
  if (targetTop >= modTop) return `You can't moderate **${target.displayName}** — they're the same rank or higher than you`;
  return null;
}

// Smarter hierarchy check for role assignment — allows harmless self-assignment
export const DANGEROUS_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MentionEveryone,
];

export function checkRoleAssignment(moderator, target, role, guild) {
  if (!moderator) return "Could not verify moderator permissions — member not found";
  if (target.id === guild.ownerId) return `Can't modify the server owner's roles`;
  if (moderator.id === guild.ownerId) return null;
  const modTop = moderator.roles.highest.position;

  // Self-assignment: allow if the role has no dangerous permissions
  if (target.id === moderator.id) {
    const isDangerous = DANGEROUS_PERMS.some((p) => role.permissions.has(p));
    if (!isDangerous) return null; // harmless role like "Druid Gremlin" — fine
    return `Can't assign **${role.name}** through me — Discord blocks bots from giving out roles with elevated permissions (admin/mod) as a safety measure. Go to **Server Settings > Roles** and drag it onto yourself manually.`;
  }

  // Cross-user: can't touch someone ranked same or higher
  const targetTop = target.roles.highest.position;
  if (targetTop >= modTop) return `You can't modify **${target.displayName}**'s roles — they're the same rank or higher`;

  // Can't assign a role ranked above your own
  if (role.position >= modTop) return `Can't assign **${role.name}** — it sits higher in the hierarchy than your top role. Go to **Server Settings > Roles** to assign it manually.`;

  return null;
}
