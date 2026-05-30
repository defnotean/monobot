// ─── Info Executor ──────────────────────────────────────────────────────────
//
// Read-only server/member introspection plus the per-user DM preference toggle.
// Several of these are CACHEABLE_TOOLS in executor.js, so they must stay pure
// reads with stable output. Long lists (channels/roles/members/permissions) are
// truncated to Discord's 2000-char message limit.

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { setDmOptout } from "../../database.js";

const HANDLED = new Set([
  "get_server_info", "set_dm_preference", "get_user_info",
  "list_channels", "list_roles", "get_role_permissions",
  "list_bans", "random_member", "count_members", "who_has_role",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findMember, findRole } = ctx;

  switch (toolName) {
    case "get_server_info": {
      const owner = await guild.fetchOwner();
      return `Server: ${guild.name}\nMembers: ${guild.memberCount}\nChannels: ${guild.channels.cache.size}\nRoles: ${guild.roles.cache.size}\nEmojis: ${guild.emojis.cache.size}\nBoosts: Level ${guild.premiumTier} (${guild.premiumSubscriptionCount})\nOwner: ${owner.user.tag}\nCreated: ${guild.createdAt.toDateString()}`;
    }

    case "set_dm_preference": {
      let targetId = message.author.id;
      let targetName = message.author.username;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator) ||
          message.member?.id === guild.ownerId;
        if (member.id !== message.author.id && !isAdmin) {
          return `You can only change your own DM preference`;
        }
        targetId = member.id;
        targetName = member.user.username;
      }
      setDmOptout(targetId, !input.allow_dms);
      return input.allow_dms
        ? `got it — i'll DM ${targetId === message.author.id ? "you" : targetName} again`
        : `got it — i won't DM ${targetId === message.author.id ? "you" : targetName} anymore`;
    }

    case "get_user_info": {
      const member = findMember(guild, input.username);
      if (!member) return `Couldn't find user "${input.username}"`;
      const roles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name).join(", ") || "None";
      return `User: ${member.user.tag}\nNickname: ${member.nickname || "None"}\nJoined: ${member.joinedAt.toDateString()}\nCreated: ${member.user.createdAt.toDateString()}\nRoles: ${roles}\nBot: ${member.user.bot ? "Yes" : "No"}`;
    }

    case "list_channels": {
      const cats = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
      const lines = [];
      for (const cat of cats.values()) {
        lines.push(`📁 ${cat.name} [id:${cat.id}]`);
        const children = guild.channels.cache.filter((c) => c.parentId === cat.id).sort((a, b) => a.position - b.position);
        for (const ch of children.values()) {
          const prefix = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
          lines.push(`  ${prefix} ${ch.name} [id:${ch.id}]`);
        }
      }
      const orphans = guild.channels.cache.filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory);
      for (const ch of orphans.values()) {
        const prefix = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
        lines.push(`${prefix} ${ch.name} [id:${ch.id}]`);
      }
      // Truncate so we never overflow Discord's 2000-char message limit on
      // servers with hundreds of channels.
      const MAX = 1900;
      let out = lines.join("\n");
      if (out.length > MAX) {
        const trimmed = lines.slice(0, Math.floor(lines.length * (MAX / out.length)));
        out = trimmed.join("\n") + `\n…(${lines.length - trimmed.length} more channels truncated)`;
      }
      return out || "No channels";
    }

    case "list_roles": {
      // Compact format to avoid truncation on servers with many roles
      const roles = guild.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
      return `${roles.size} roles: ${roles.map((r) => {
        const icon = r.unicodeEmoji ? ` ${r.unicodeEmoji}` : r.icon ? ` [custom icon]` : "";
        return `${r.name}${icon}`;
      }).join(", ")}` || "No roles";
    }

    case "get_role_permissions": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;

      const PERM_NAMES = {
        Administrator:           PermissionFlagsBits.Administrator,
        "Manage Guild":          PermissionFlagsBits.ManageGuild,
        "Manage Channels":       PermissionFlagsBits.ManageChannels,
        "Manage Roles":          PermissionFlagsBits.ManageRoles,
        "Manage Messages":       PermissionFlagsBits.ManageMessages,
        "Manage Nicknames":      PermissionFlagsBits.ManageNicknames,
        "Manage Webhooks":       PermissionFlagsBits.ManageWebhooks,
        "Manage Emojis":         PermissionFlagsBits.ManageGuildExpressions,
        "Kick Members":          PermissionFlagsBits.KickMembers,
        "Ban Members":           PermissionFlagsBits.BanMembers,
        "Timeout Members":       PermissionFlagsBits.ModerateMembers,
        "View Audit Log":        PermissionFlagsBits.ViewAuditLog,
        "View Channels":         PermissionFlagsBits.ViewChannel,
        "Send Messages":         PermissionFlagsBits.SendMessages,
        "Send TTS Messages":     PermissionFlagsBits.SendTTSMessages,
        "Embed Links":           PermissionFlagsBits.EmbedLinks,
        "Attach Files":          PermissionFlagsBits.AttachFiles,
        "Add Reactions":         PermissionFlagsBits.AddReactions,
        "Use External Emojis":   PermissionFlagsBits.UseExternalEmojis,
        "Mention Everyone":      PermissionFlagsBits.MentionEveryone,
        "Read Message History":  PermissionFlagsBits.ReadMessageHistory,
        "Use Slash Commands":    PermissionFlagsBits.UseApplicationCommands,
        "Connect (Voice)":       PermissionFlagsBits.Connect,
        "Speak (Voice)":         PermissionFlagsBits.Speak,
        "Stream (Voice)":        PermissionFlagsBits.Stream,
        "Move Members (Voice)":  PermissionFlagsBits.MoveMembers,
        "Mute Members (Voice)":  PermissionFlagsBits.MuteMembers,
        "Deafen Members (Voice)":PermissionFlagsBits.DeafenMembers,
        "Priority Speaker":      PermissionFlagsBits.PrioritySpeaker,
        "Change Nickname":       PermissionFlagsBits.ChangeNickname,
        "Create Invites":        PermissionFlagsBits.CreateInstantInvite,
      };

      const granted = [];
      const denied  = [];
      for (const [name, flag] of Object.entries(PERM_NAMES)) {
        (role.permissions.has(flag) ? granted : denied).push(name);
      }

      const color = role.color ? `#${role.color.toString(16).padStart(6, "0")}` : "none";
      const header = `**@${role.name}** (position ${role.position}, color: ${color}, ${role.members.size} members)\n`;
      // Truncate granted/denied lists so we don't overflow Discord's 2000-char
      // message limit. Admin roles often hit this — only one of the two halves
      // is usually long, so favor the shorter of the two for full detail.
      const MAX_LINE = 750;
      const trimList = (items) => {
        let out = items.join(", ");
        if (out.length <= MAX_LINE) return out;
        const truncated = [];
        let used = 0;
        for (const item of items) {
          if (used + item.length + 2 > MAX_LINE) break;
          truncated.push(item);
          used += item.length + 2;
        }
        return `${truncated.join(", ")}, …(+${items.length - truncated.length} more)`;
      };
      return header + `✅ Granted: ${trimList(granted) || "none"}\n` + `❌ Denied: ${trimList(denied) || "none"}`;
    }

    case "list_bans": {
      const bans = await guild.bans.fetch({ limit: 50 });
      if (!bans.size) return "No banned users";
      return bans.map((b) => `${b.user.tag} — ${b.reason || "No reason"}`).join("\n");
    }

    case "random_member": {
      await guild.members.fetch({ limit: 100 });
      let members = guild.members.cache.filter((m) => !m.user.bot);
      if (input.role_name) {
        const role = findRole(guild, input.role_name);
        if (!role) return `Couldn't find role "${input.role_name}"`;
        members = members.filter((m) => m.roles.cache.has(role.id));
      }
      const arr = [...members.values()];
      if (!arr.length) return "No members found matching that filter";
      const count = Math.min(input.count || 1, arr.length, 10);
      const picked = [];
      const used = new Set();
      while (picked.length < count && picked.length < arr.length) {
        const idx = Math.floor(Math.random() * arr.length);
        if (!used.has(idx)) { used.add(idx); picked.push(arr[idx]); }
      }
      return picked.map((m) => m.user.tag).join(", ") || "No members found";
    }

    case "count_members": {
      await guild.members.fetch({ limit: 100 });
      let members = guild.members.cache.filter((m) => !m.user.bot);
      if (input.role_name) {
        const role = findRole(guild, input.role_name);
        if (!role) return `Couldn't find role "${input.role_name}"`;
        members = members.filter((m) => m.roles.cache.has(role.id));
      }
      if (input.status) {
        members = members.filter((m) => m.presence?.status === input.status);
      }
      return `${members.size} members${input.role_name ? ` with "${input.role_name}"` : ""}${input.status ? ` (${input.status})` : ""}`;
    }

    case "who_has_role": {
      const role = findRole(guild, input.role_name);
      if (!role) return `Couldn't find role "${input.role_name}"`;
      const members = role.members.filter((m) => !m.user.bot);
      if (!members.size) return `No one has the "${role.name}" role`;
      // Truncate so we never overflow Discord's 2000-char message limit. A
      // role with hundreds of members previously made the parent send fail.
      const tags = [...members.values()].map((m) => m.user.tag);
      const MAX_LIST_CHARS = 1500;
      let used = 0;
      const taken = [];
      for (const tag of tags) {
        if (used + tag.length + 2 > MAX_LIST_CHARS) break;
        taken.push(tag);
        used += tag.length + 2;
      }
      const remainder = members.size - taken.length;
      const suffix = remainder > 0 ? ` (and ${remainder} more)` : "";
      return `${members.size} members with "${role.name}": ${taken.join(", ")}${suffix}`;
    }
  }
}
