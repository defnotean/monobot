// ─── Role Management Executor ───────────────────────────────────────────────

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { log } from "../../utils/logger.js";
import { isAdminMember } from "../../utils/permissions.js";

const HANDLED = new Set([
  "create_role", "delete_role", "edit_role", "reorder_roles",
  "create_category", "delete_category", "set_role_permissions",
  "give_role", "remove_role", "mass_role", "set_role_icons",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  // Defense-in-depth: every tool routed through this executor is destructive.
  // The primary ADMIN_TOOLS gate runs in dual.js; this is a backup so a
  // regression in the gate logic can't bypass authentication.
  if (!isAdminMember(message.member)) {
    return "permission denied";
  }

  const { guild, by, findRole, findMember, parseHexColor, checkRoleAssignment } = ctx;

  switch (toolName) {
    case "create_category": {
      const cat = await guild.channels.create({ name: input.name, type: ChannelType.GuildCategory, reason: `Created ${by}` });
      return `Created category "${cat.name}"`;
    }

    case "delete_category": {
      const cat = guild.channels.cache.find((c) => c.name.toLowerCase() === input.name.toLowerCase() && c.type === ChannelType.GuildCategory);
      if (!cat) return `Couldn't find category "${input.name}"`;
      await cat.delete(`Deleted ${by}`);
      return `Deleted category "${input.name}"`;
    }

    case "set_role_permissions": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;

      const map = {
        view_channels:      PermissionFlagsBits.ViewChannel,
        send_messages:      PermissionFlagsBits.SendMessages,
        read_history:       PermissionFlagsBits.ReadMessageHistory,
        embed_links:        PermissionFlagsBits.EmbedLinks,
        attach_files:       PermissionFlagsBits.AttachFiles,
        add_reactions:      PermissionFlagsBits.AddReactions,
        use_ext_emoji:      PermissionFlagsBits.UseExternalEmojis,
        use_slash_commands: PermissionFlagsBits.UseApplicationCommands,
        mention_everyone:   PermissionFlagsBits.MentionEveryone,
        manage_messages:    PermissionFlagsBits.ManageMessages,
        manage_channels:    PermissionFlagsBits.ManageChannels,
        manage_roles:       PermissionFlagsBits.ManageRoles,
        manage_guild:       PermissionFlagsBits.ManageGuild,
        kick_members:       PermissionFlagsBits.KickMembers,
        ban_members:        PermissionFlagsBits.BanMembers,
        timeout_members:    PermissionFlagsBits.ModerateMembers,
        view_audit_log:     PermissionFlagsBits.ViewAuditLog,
        connect_voice:      PermissionFlagsBits.Connect,
        speak_voice:        PermissionFlagsBits.Speak,
        stream:             PermissionFlagsBits.Stream,
        move_members:       PermissionFlagsBits.MoveMembers,
        mute_members:       PermissionFlagsBits.MuteMembers,
        deafen_members:     PermissionFlagsBits.DeafenMembers,
        administrator:      PermissionFlagsBits.Administrator,
      };

      let perms = role.permissions.bitfield;
      const changed = [];
      for (const [key, flag] of Object.entries(map)) {
        if (input[key] === true)  { perms |= flag;  changed.push(`+${key}`); }
        if (input[key] === false) { perms &= ~flag; changed.push(`-${key}`); }
      }
      if (!changed.length) return "No permission changes specified";
      await role.setPermissions(perms, `Permissions set ${by}`);
      return `Updated @${role.name} permissions: ${changed.join(", ")}`;
    }

    case "create_role": {
      const color = parseHexColor(input.color);
      const createOpts = { name: input.name, color, hoist: input.hoist || false, mentionable: input.mentionable || false, reason: `Created ${by}` };
      if (input.icon) {
        const isEmoji = /^\p{Emoji}$/u.test(input.icon.trim());
        if (isEmoji) createOpts.unicodeEmoji = input.icon.trim();
        else createOpts.icon = input.icon.trim();
      }
      try {
        const role = await guild.roles.create(createOpts);
        return `Created role "${role.name}"${input.icon ? ` with icon ${input.icon}` : ""}`;
      } catch (err) {
        if (err.code === 50013 || err.message?.includes("Missing Permissions")) return `Created role but couldn't set icon — bot is missing permissions`;
        if (err.code === 50035 || err.message?.includes("FEATURES")) return `Couldn't create role with icon — server needs Boost Level 2+ for role icons`;
        throw err;
      }
    }

    case "delete_role": {
      const role = findRole(guild, input.name);
      if (!role) return `Couldn't find role "${input.name}"`;
      await role.delete(`Deleted ${by}`);
      return `Deleted role "${input.name}"`;
    }

    case "edit_role": {
      const role = findRole(guild, input.name);
      if (!role) return `Couldn't find role "${input.name}"`;
      const opts = {};
      if (input.new_name) opts.name = input.new_name;
      if (input.color) opts.color = parseHexColor(input.color);
      if (input.hoist !== undefined) opts.hoist = input.hoist;
      if (input.mentionable !== undefined) opts.mentionable = input.mentionable;
      if (input.icon !== undefined) {
        if (input.icon === "none") {
          opts.unicodeEmoji = null;
          opts.icon = null;
        } else {
          const isEmoji = /^\p{Emoji}$/u.test(input.icon.trim());
          if (isEmoji) { opts.unicodeEmoji = input.icon.trim(); opts.icon = null; }
          else { opts.icon = input.icon.trim(); opts.unicodeEmoji = null; }
        }
      }
      try {
        await role.edit(opts);
        return `Updated role "${input.name}"${input.new_name ? ` (renamed to "${input.new_name}")` : ""}${input.icon ? ` — icon set to ${input.icon}` : ""}`;
      } catch (err) {
        if (err.code === 50035 || err.message?.includes("FEATURES")) return `Couldn't set role icon — server needs Boost Level 2+ for role icons`;
        throw err;
      }
    }

    case "reorder_roles": {
      // Build position map: resolve each role name and set its position
      const updates = [];
      for (const entry of input.roles) {
        const role = findRole(guild, entry.name);
        if (!role) return `Couldn't find role "${entry.name}"`;
        updates.push({ role: role.id, position: entry.position });
      }
      try {
        await guild.roles.setPositions(updates);
        return `Reordered ${updates.length} roles`;
      } catch (err) {
        if (err.code === 50013 || err.message?.includes("Missing Permissions")) {
          return (
            "I can't reorder those roles because they're at or above my own position in the hierarchy — Discord won't let me touch them.\n\n" +
            "To fix this, drag the roles manually in **Server Settings → Roles**:\n" +
            "1. **Admin** — top\n" +
            "2. **Moderator** (or Mod) — below Admin\n" +
            "3. **Staff** — below Moderator\n" +
            "4. **Member** — below Staff\n\n" +
            "Takes about 30 seconds and everything will be in the right order."
          );
        }
        return `Failed to reorder roles: ${err.message}`;
      }
    }

    case "give_role": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      const roleErr = checkRoleAssignment(message.member, member, role, guild);
      if (roleErr) return roleErr;
      try {
        await member.roles.add(role, `Given ${by}`);
      } catch (err) {
        if (err.code === 50013) return `Missing permissions — make sure the bot role is above "${role.name}" in the hierarchy`;
        if (err.code === 10011) return `Role "${role.name}" no longer exists`;
        throw err;
      }
      return `Gave ${member.user.tag} the "${role.name}" role`;
    }

    case "remove_role": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      const removeRoleErr = checkRoleAssignment(message.member, member, role, guild);
      if (removeRoleErr) return removeRoleErr;
      try {
        await member.roles.remove(role, `Removed ${by}`);
      } catch (err) {
        if (err.code === 50013) return `Missing permissions — make sure the bot role is above "${role.name}" in the hierarchy`;
        if (err.code === 10011) return `Role "${role.name}" no longer exists`;
        throw err;
      }
      return `Removed "${role.name}" from ${member.user.tag}`;
    }

    case "mass_role": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      // Fetch ALL members, not just the first 100 — the old `{ limit: 100 }`
      // silently skipped every user past the limit on large guilds, meaning
      // a "give role to everyone" ran on 100/10,000 members. discord.js
      // handles pagination automatically when no limit is passed.
      await guild.members.fetch().catch((err) => log(`[mass_role] fetch warning: ${err.message}`));
      let targets = guild.members.cache;
      if (input.filter_role) {
        const filterRole = findRole(guild, input.filter_role);
        if (!filterRole) return `Couldn't find filter role "${input.filter_role}"`;
        targets = targets.filter((m) => m.roles.cache.has(filterRole.id));
      }
      targets = targets.filter((m) => !m.user.bot);
      // Chunk the role mutations to 25 at a time so we don't hammer the API
      // and eat rate limits on servers with thousands of members.
      const list = [...targets.values()];
      let count = 0, failed = 0;
      for (let i = 0; i < list.length; i += 25) {
        const chunk = list.slice(i, i + 25);
        const results = await Promise.allSettled(
          chunk.map(async (m) => {
            if (input.action === "give") await m.roles.add(role);
            else await m.roles.remove(role);
          })
        );
        count += results.filter((r) => r.status === "fulfilled").length;
        failed += results.filter((r) => r.status === "rejected").length;
      }
      const failNote = failed ? ` (${failed} skipped — no permission)` : "";
      return `${input.action === "give" ? "Gave" : "Removed"} "${role.name}" ${input.action === "give" ? "to" : "from"} ${count} members${failNote}`;
    }

    case "set_role_icons": {
      const results = [];
      for (const entry of input.roles) {
        const role = findRole(guild, entry.name);
        if (!role) { results.push(`"${entry.name}" — not found`); continue; }
        const opts = {};
        if (entry.icon === "none") {
          opts.unicodeEmoji = null;
          opts.icon = null;
        } else {
          const isEmoji = /^\p{Emoji}$/u.test(entry.icon.trim());
          if (isEmoji) { opts.unicodeEmoji = entry.icon.trim(); opts.icon = null; }
          else { opts.icon = entry.icon.trim(); opts.unicodeEmoji = null; }
        }
        try {
          await role.edit(opts);
          results.push(`"${role.name}" → ${entry.icon}`);
        } catch (err) {
          if (err.code === 50035 || err.message?.includes("FEATURES")) {
            return `Can't set role icons — server needs Boost Level 2+ for role icons`;
          }
          results.push(`"${entry.name}" — failed: ${err.message}`);
        }
      }
      return results.join("\n");
    }
  }
}
