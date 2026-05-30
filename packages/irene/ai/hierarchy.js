// @ts-check
/**
 * @file packages/irene/ai/hierarchy.js
 *
 * Role-hierarchy / moderation permission gates for Irene's AI executor.
 * Shared by the moderation and role executors so caller/bot hierarchy rules
 * stay consistent across direct assignments, mass assignments, and role
 * mutations.
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

export function roleHasDangerousPermissions(role) {
  return DANGEROUS_PERMS.some((p) => role?.permissions?.has?.(p));
}

export function checkRoleMutationHierarchy(moderator, role, guild, action = "modify") {
  if (!moderator) return "Could not verify moderator permissions — member not found";
  if (!role) return "Could not verify role hierarchy — role not found";
  if (role.id === guild.id || role.name === "@everyone") return `Can't ${action} the @everyone role`;
  if (role.managed) return `Can't ${action} **${role.name}** — it's managed by an integration`;

  const bot = guild.members?.me;
  const botTop = bot?.roles?.highest?.position;
  if (typeof botTop === "number" && role.position >= botTop) {
    return `I can't ${action} **${role.name}** — it sits at or above my top role`;
  }

  if (moderator.id === guild.ownerId) return null;
  const modTop = moderator.roles?.highest?.position;
  if (typeof modTop !== "number") return "Could not verify moderator role hierarchy";
  if (role.position >= modTop) {
    return `You can't ${action} **${role.name}** — it sits at or above your top role`;
  }

  return null;
}

export function checkRoleReorderHierarchy(moderator, role, newPosition, guild) {
  const roleErr = checkRoleMutationHierarchy(moderator, role, guild, "reorder");
  if (roleErr) return roleErr;

  const botTop = guild.members?.me?.roles?.highest?.position;
  if (typeof botTop === "number" && newPosition >= botTop) {
    return `I can't move **${role.name}** that high — it would be at or above my top role`;
  }

  if (moderator.id !== guild.ownerId) {
    const modTop = moderator.roles?.highest?.position;
    if (typeof modTop !== "number") return "Could not verify moderator role hierarchy";
    if (newPosition >= modTop) {
      return `You can't move **${role.name}** that high — it would be at or above your top role`;
    }
  }

  return null;
}

export function checkRoleAssignment(moderator, target, role, guild) {
  if (!moderator) return "Could not verify moderator permissions — member not found";
  if (target.id === guild.ownerId) return `Can't modify the server owner's roles`;
  if (role.id === guild.id || role.name === "@everyone") return `Can't modify the @everyone role`;
  if (role.managed) return `Can't modify **${role.name}** — it's managed by an integration`;

  const botTop = guild.members?.me?.roles?.highest?.position;
  if (typeof botTop === "number" && role.position >= botTop) {
    return `Missing permissions — make sure the bot role is above "${role.name}" in the hierarchy`;
  }
  const botTargetTop = target.roles?.highest?.position;
  if (typeof botTop === "number" && typeof botTargetTop === "number" && botTargetTop >= botTop) {
    return `I can't modify **${target.displayName}**'s roles — they're the same rank or higher than me`;
  }

  if (moderator.id === guild.ownerId) return null;
  const modTop = moderator.roles.highest.position;

  // Self-assignment: allow if the role has no dangerous permissions
  if (target.id === moderator.id) {
    const isDangerous = roleHasDangerousPermissions(role);
    if (!isDangerous) return null;
    return `Can't assign **${role.name}** through me — Discord blocks bots from giving out roles with elevated permissions (admin/mod) as a safety measure. Go to **Server Settings > Roles** and drag it onto yourself manually.`;
  }

  // Cross-user: can't touch someone ranked same or higher
  const targetTop = target.roles.highest.position;
  if (targetTop >= modTop) return `You can't modify **${target.displayName}**'s roles — they're the same rank or higher`;

  // Can't assign a role ranked above your own
  if (role.position >= modTop) return `Can't assign **${role.name}** — it sits higher in the hierarchy than your top role. Go to **Server Settings > Roles** to assign it manually.`;

  return null;
}
