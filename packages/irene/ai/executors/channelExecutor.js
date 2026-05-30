// ─── Channel Management Executor ────────────────────────────────────────────

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { logAudit } from "../../database.js";
import { sendModLog } from "../../utils/logger.js";
import { modEmbed } from "../../utils/embeds.js";
import { hasManageChannelsMember } from "../../utils/permissions.js";

const HANDLED = new Set([
  "create_channel", "delete_channel", "nuke_channel", "rename_channel",
  "set_channel_topic", "set_slowmode", "lock_channel", "unlock_channel",
  "move_channel", "clone_channel", "set_channel_permissions",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  // Defense-in-depth: every tool routed through this executor mutates channel
  // state, so require the exact Discord permission instead of the broader
  // admin/trusted gate used for low-risk server configuration.
  if (!hasManageChannelsMember(message.member)) {
    return "permission denied — you need Manage Channels";
  }
  if (!hasManageChannelsMember(message.guild?.members?.me ?? ctx.guild?.members?.me)) {
    return "I need Manage Channels to do that";
  }

  const { guild, by, findChannel, findMember, findRole } = ctx;

  switch (toolName) {
    case "create_channel": {
      const typeMap = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, stage: ChannelType.GuildStageVoice, forum: ChannelType.GuildForum };
      const channelType = typeMap[input.type] || ChannelType.GuildText;

      let parent = null;
      if (input.category) {
        parent = guild.channels.cache.find(
          (c) => c.name.toLowerCase() === input.category.toLowerCase() && c.type === ChannelType.GuildCategory
        );
      }

      // Build permission overwrites for private channels
      const permissionOverwrites = [];
      if (input.private) {
        // Deny everyone
        permissionOverwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        // Allow the bot
        permissionOverwrites.push({ id: message.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] });
        // Allow the requester
        permissionOverwrites.push({ id: message.author.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });

        // Allow specified users
        if (input.allowed_users) {
          for (const uname of input.allowed_users) {
            const member = findMember(guild, uname);
            if (member) {
              permissionOverwrites.push({ id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
            }
          }
        }
        // Allow specified roles
        if (input.allowed_roles) {
          for (const rname of input.allowed_roles) {
            const role = findRole(guild, rname);
            if (role) {
              permissionOverwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
            }
          }
        }
      }

      const ch = await guild.channels.create({
        name: input.name,
        type: channelType,
        parent: parent?.id,
        topic: input.topic || undefined,
        nsfw: input.nsfw || false,
        rateLimitPerUser: input.slowmode || undefined,
        userLimit: input.user_limit || undefined,
        permissionOverwrites: permissionOverwrites.length ? permissionOverwrites : undefined,
        reason: `Created ${by}`,
      });

      let desc = `Created ${input.type || "text"} channel #${ch.name}`;
      if (parent) desc += ` under ${parent.name}`;
      if (input.private) desc += ` (private — only allowed users/roles can see it)`;
      return desc;
    }

    case "delete_channel": {
      const target = input.channel_id || input.name || input.channel_name;
      const ch = findChannel(guild, target);
      if (!ch) return `Couldn't find channel "${target}"`;
      const name = ch.name;
      await ch.delete(`Deleted ${by}`);
      logAudit(guild.id, "delete_channel", message.author.id, target);
      return `Deleted channel #${name}`;
    }

    case "nuke_channel": {
      const target = input.channel_id || input.channel_name;
      const ch = target ? findChannel(guild, target) : message.channel;
      if (!ch) return `Couldn't find channel "${target}"`;
      if (!ch.isTextBased()) return "Can only nuke text channels";
      const name = ch.name;
      const clone = await ch.clone({ reason: `Nuked ${by}` });
      await clone.setPosition(ch.position).catch(() => {});
      await ch.delete(`Nuked ${by}`);
      await clone.send(`Channel has been reset by ${message.author}.`);
      await sendModLog(guild, modEmbed("Channel Nuked", `**Channel:** #${name}\n**By:** ${message.author.tag}`));
      logAudit(guild.id, "nuke_channel", message.author.id, name);
      return `Nuked #${name} — all messages wiped`;
    }

    case "rename_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const old = ch.name;
      await ch.setName(input.new_name, `Renamed ${by}`);
      return `Renamed #${old} to #${input.new_name}`;
    }

    case "set_channel_topic": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      await ch.setTopic(input.topic, `Set ${by}`);
      return `Set topic for #${ch.name}`;
    }

    case "set_slowmode": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const seconds = Math.min(Math.max(Math.floor(input.seconds ?? 0), 0), 21600);
      await ch.setRateLimitPerUser(seconds, `Set ${by}`);
      return seconds === 0 ? `Disabled slowmode on #${ch.name}` : `Set slowmode to ${seconds}s on #${ch.name}`;
    }

    case "lock_channel": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      await ch.permissionOverwrites.edit(guild.id, { SendMessages: false }, { reason: `Locked ${by}` });
      return `Locked #${ch.name}`;
    }

    case "unlock_channel": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      await ch.permissionOverwrites.edit(guild.id, { SendMessages: null }, { reason: `Unlocked ${by}` });
      return `Unlocked #${ch.name}`;
    }

    case "move_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const cat = guild.channels.cache.find((c) => c.name.toLowerCase() === input.category_name.toLowerCase() && c.type === ChannelType.GuildCategory);
      if (!cat) return `Couldn't find category "${input.category_name}"`;
      await ch.setParent(cat.id, { reason: `Moved ${by}` });
      return `Moved #${ch.name} to ${cat.name}`;
    }

    case "clone_channel": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      const clone = await ch.clone({ name: input.new_name || `${ch.name}-copy`, reason: `Cloned ${by}` });
      return `Cloned #${ch.name} as #${clone.name}`;
    }

    case "set_channel_permissions": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      let target;
      if (input.target_type === "user") {
        target = findMember(guild, input.target);
        if (!target) return `Couldn't find user "${input.target}"`;
      } else {
        target = findRole(guild, input.target);
        if (!target) return `Couldn't find role "${input.target}"`;
      }
      const targetId = target.id;
      // Reset: remove all overrides for this target
      if (input.reset) {
        await ch.permissionOverwrites.delete(targetId, `Permissions reset ${by}`);
        return `Reset all permission overrides for ${input.target} on #${ch.name}`;
      }
      const p = (v) => (v === undefined ? undefined : v === null ? null : v);
      const perms = {};
      if (input.allow_view          !== undefined) perms.ViewChannel           = p(input.allow_view);
      if (input.allow_send          !== undefined) perms.SendMessages          = p(input.allow_send);
      if (input.allow_read_history  !== undefined) perms.ReadMessageHistory    = p(input.allow_read_history);
      if (input.allow_react         !== undefined) perms.AddReactions          = p(input.allow_react);
      if (input.allow_attach        !== undefined) perms.AttachFiles           = p(input.allow_attach);
      if (input.allow_embed_links   !== undefined) perms.EmbedLinks            = p(input.allow_embed_links);
      if (input.allow_use_ext_emoji !== undefined) perms.UseExternalEmojis     = p(input.allow_use_ext_emoji);
      if (input.allow_mention_everyone !== undefined) perms.MentionEveryone    = p(input.allow_mention_everyone);
      if (input.allow_manage_messages !== undefined) perms.ManageMessages      = p(input.allow_manage_messages);
      if (input.allow_use_slash     !== undefined) perms.UseApplicationCommands = p(input.allow_use_slash);
      if (input.allow_connect       !== undefined) perms.Connect               = p(input.allow_connect);
      if (input.allow_speak         !== undefined) perms.Speak                 = p(input.allow_speak);
      if (input.allow_stream        !== undefined) perms.Stream                = p(input.allow_stream);
      if (input.allow_move_members  !== undefined) perms.MoveMembers           = p(input.allow_move_members);
      if (!Object.keys(perms).length) return "No permission changes specified";
      await ch.permissionOverwrites.edit(targetId, perms, { reason: `Permissions set ${by}` });
      const changed = Object.entries(perms).map(([k, v]) => `${k}: ${v === null ? "inherit" : v}`).join(", ");
      return `Updated permissions for ${input.target} on #${ch.name} — ${changed}`;
    }
  }
}
