// ─── Custom Command Executor ────────────────────────────────────────────────
//
// AI-managed `!trigger` commands stored per-guild. Create/edit/delete/list.
// Embed colors accept either a named color (resolved via COLOR_NAMES) or a raw
// hex; "none" clears the color.

import { PermissionFlagsBits } from "discord.js";
import { getCustomCommand, setCustomCommand, deleteCustomCommand, listCustomCommands } from "../../database.js";
import { COLOR_NAMES } from "../colors.js";
import { DANGEROUS_PERMS } from "../hierarchy.js";
import { hasManageRolesMember } from "../../utils/permissions.js";

const HANDLED = new Set([
  "create_custom_command", "edit_custom_command",
  "delete_custom_command", "list_custom_commands",
]);

export function resolveCustomCommandRole(guild, value, findRole) {
  if (!value) return null;
  const raw = String(value).trim();
  const id = raw.match(/^<@&(\d+)>$/)?.[1] ?? raw;
  return guild.roles.cache.get(id) ?? findRole?.(guild, raw) ?? null;
}

function roleHasDangerousPerm(role) {
  return DANGEROUS_PERMS.some((perm) => role.permissions?.has?.(perm));
}

/**
 * @param {any} guild
 * @param {any} role
 * @param {{ actor?: any, actionLabel?: string, requireActorManageRoles?: boolean }} [options]
 */
export function validateAssignableRole(guild, role, { actor = null, actionLabel = "Custom commands", requireActorManageRoles = false } = {}) {
  if (!role) return "Couldn't find that role";
  if (role.id === guild.id) return `${actionLabel} can't manage @everyone.`;
  if (role.managed) return `${actionLabel} can't manage **${role.name}** because Discord manages that role.`;
  if (roleHasDangerousPerm(role)) return `${actionLabel} can't manage **${role.name}** because it has elevated permissions.`;

  const botMember = guild.members?.me;
  const botTop = botMember?.roles?.highest?.position;
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return `I need Manage Roles before ${actionLabel.toLowerCase()} can manage roles.`;
  if (botTop != null && role.position >= botTop) return `${actionLabel} can't manage **${role.name}** because it is at or above my top role.`;

  if (actor && actor.id !== guild.ownerId) {
    if (requireActorManageRoles && !hasManageRolesMember(actor)) {
      return `${actionLabel} requires Manage Roles before you can configure role assignment.`;
    }
    const actorTop = actor.roles?.highest?.position;
    if (actorTop != null && role.position >= actorTop) {
      return `${actionLabel} can't manage **${role.name}** because it is at or above your top role.`;
    }
  }

  return null;
}

/**
 * @param {any} guild
 * @param {Record<string, any>} command
 * @param {{ actor?: any, findRole?: Function }} [options]
 */
function validateCommandRoles(guild, command, { actor = null, findRole } = {}) {
  for (const key of ["role_to_give", "role_to_remove"]) {
    if (!command[key]) continue;
    const role = resolveCustomCommandRole(guild, command[key], findRole);
    const reason = validateAssignableRole(guild, role, { actor, requireActorManageRoles: true });
    if (reason) return reason;
  }
  return null;
}

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild } = ctx;

  switch (toolName) {
    case "create_custom_command": {
      const existing = getCustomCommand(guild.id, input.trigger);
      if (existing) return `!${input.trigger} already exists. Use edit_custom_command to modify it.`;
      const roleReason = validateCommandRoles(guild, input, {
        actor: message.member,
        findRole: ctx.findRole,
      });
      if (roleReason) return roleReason;
      const colorNames = COLOR_NAMES;
      let embedColor = null;
      if (input.embed_color) {
        const raw = input.embed_color.toLowerCase().trim();
        if (raw && raw !== "none") {
          embedColor = colorNames[raw] ?? (raw.startsWith("#") ? raw : `#${raw}`);
        }
      }
      setCustomCommand(guild.id, input.trigger, {
        description: input.description, response: input.response,
        role_to_give: input.role_to_give || null, role_to_remove: input.role_to_remove || null,
        embed_title: input.embed_title || null, embed_color: embedColor,
        embed_url: input.embed_url || null, embed_image: input.embed_image || null,
        embed_thumbnail: input.embed_thumbnail || null, embed_footer: input.embed_footer || null,
        embed_author: input.embed_author || null, embed_author_icon: input.embed_author_icon || null,
        admin_only: input.admin_only || false, auto_delete: input.auto_delete || false,
        created_by: message.author.id,
      });
      return `Created command !${input.trigger}`;
    }

    case "edit_custom_command": {
      const cmd = getCustomCommand(guild.id, input.trigger);
      if (!cmd) return `!${input.trigger} doesn't exist`;
      const updated = { ...cmd };
      if (input.cmd_description !== undefined) updated.description = input.cmd_description || null;
      for (const key of ["response", "role_to_give", "role_to_remove"]) {
        if (input[key] !== undefined) updated[key] = input[key] || null;
      }
      // Booleans must not be coerced — false || null would wrongly store null
      for (const key of ["admin_only", "auto_delete"]) {
        if (input[key] !== undefined) updated[key] = input[key];
      }
      for (const key of ["embed_title", "embed_url", "embed_image", "embed_thumbnail", "embed_footer", "embed_author", "embed_author_icon"]) {
        if (input[key] !== undefined) updated[key] = input[key] === "none" ? null : (input[key] || null);
      }
      if (input.embed_color !== undefined) {
        const raw = input.embed_color?.toLowerCase().trim();
        if (!raw || raw === "none") {
          updated.embed_color = null;
        } else {
          updated.embed_color = COLOR_NAMES[raw] ?? (raw.startsWith("#") ? raw : `#${raw}`);
        }
      }
      const roleReason = validateCommandRoles(guild, updated, {
        actor: message.member,
        findRole: ctx.findRole,
      });
      if (roleReason) return roleReason;
      setCustomCommand(guild.id, input.trigger, updated);
      return `Updated !${input.trigger}`;
    }

    case "delete_custom_command": {
      return deleteCustomCommand(guild.id, input.trigger) ? `Deleted !${input.trigger}` : `!${input.trigger} doesn't exist`;
    }

    case "list_custom_commands": {
      const cmds = listCustomCommands(guild.id);
      if (!cmds.length) return "No custom commands yet";
      return cmds.map((c) => `!${c.trigger} — ${c.description}${c.admin_only ? " (admin only)" : ""}`).join("\n");
    }
  }
}
