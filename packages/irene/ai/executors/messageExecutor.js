// ─── Message Management Executor ────────────────────────────────────────────

import {
  ComponentType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, PermissionFlagsBits,
} from "discord.js";
import { validateAssignableRole } from "./customCommandExecutor.js";
import { spotlight } from "../firewall.js";
import { isGuildOwnerMember } from "../../utils/permissions.js";

const HANDLED = new Set([
  "edit_message", "delete_message", "read_messages", "search_messages",
  "pin_message", "unpin_message", "list_pins",
  "react_to_message", "remove_reaction",
  "send_message", "send_animated_message", "create_thread",
]);

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeSendMessageArgs(input = {}) {
  const out = { ...input };
  if (input.channel && typeof input.channel === "object") {
    if (input.channel.id !== undefined) out.channel_id = input.channel.id;
    if (input.channel.name !== undefined) out.channel_name = input.channel.name;
  }
  const embed = input.embed && typeof input.embed === "object" ? input.embed : {};
  const embedMap = {
    title: "embed_title",
    description: "embed_description",
    color: "embed_color",
    image: "embed_image",
    thumbnail: "embed_thumbnail",
    fields: "embed_fields",
    timestamp: "embed_timestamp",
  };
  for (const [from, to] of Object.entries(embedMap)) {
    if (embed[from] !== undefined) out[to] = embed[from];
  }
  if (embed.author && typeof embed.author === "object") {
    if (embed.author.name !== undefined) out.embed_author = embed.author.name;
    if (embed.author.icon !== undefined) out.embed_author_icon = embed.author.icon;
  } else if (embed.author !== undefined) {
    out.embed_author = embed.author;
  }
  if (embed.footer && typeof embed.footer === "object") {
    if (embed.footer.text !== undefined) out.embed_footer = embed.footer.text;
    if (embed.footer.icon !== undefined) out.embed_footer_icon = embed.footer.icon;
  } else if (embed.footer !== undefined) {
    out.embed_footer = embed.footer;
  }
  const components = input.components && typeof input.components === "object" ? input.components : {};
  if (components.buttons !== undefined) out.buttons = components.buttons;
  if (components.dropdown !== undefined) out.dropdown = components.dropdown;
  delete out.channel;
  delete out.embed;
  delete out.components;
  return out;
}

function hasChannelPermission(channel, member, permission) {
  if (isGuildOwnerMember(member)) return true;
  const scoped = channel?.permissionsFor?.(member);
  if (!scoped && typeof channel?.permissionsFor !== "function") return Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator) || member?.permissions?.has?.(permission));
  return Boolean(scoped?.has?.(PermissionFlagsBits.Administrator) || scoped?.has?.(permission));
}

function canReadChannel(channel, member) {
  return hasChannelPermission(channel, member, PermissionFlagsBits.ViewChannel)
    && hasChannelPermission(channel, member, PermissionFlagsBits.ReadMessageHistory);
}

function canSendToChannel(channel, member) {
  return hasChannelPermission(channel, member, PermissionFlagsBits.ViewChannel)
    && hasChannelPermission(channel, member, PermissionFlagsBits.SendMessages);
}

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel, by } = ctx;
  const client = message.client;

  switch (toolName) {
    case "edit_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!hasChannelPermission(channel, message.member, PermissionFlagsBits.ManageMessages)) {
          return "You need Manage Messages to edit bot messages.";
        }
        if (!hasChannelPermission(channel, guild.members?.me, PermissionFlagsBits.ManageMessages)) {
          return "I need Manage Messages to edit messages.";
        }

        const target = await channel.messages.fetch(input.message_id);
        if (!target) return `Couldn't find message with ID ${input.message_id}`;

        if (target.author.id !== client.user.id) {
          return "I can only edit my own messages";
        }

        await target.edit({ content: input.new_content || input.content });
        return `Edited message ${input.message_id} in #${channel.name}`;
      } catch (err) {
        return `Failed to edit message: ${err.message}`;
      }
    }

    case "delete_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!canReadChannel(channel, message.member) || !hasChannelPermission(channel, message.member, PermissionFlagsBits.ManageMessages)) {
          return "You need View Channel, Read Message History, and Manage Messages to delete bot messages there.";
        }
        if (!canReadChannel(channel, guild.members?.me) || !hasChannelPermission(channel, guild.members?.me, PermissionFlagsBits.ManageMessages)) {
          return "I need View Channel, Read Message History, and Manage Messages there.";
        }
        const target = await channel.messages.fetch(input.message_id).catch(() => null);
        if (!target) return `Couldn't find message ${input.message_id}`;
        if (target.author.id !== client.user.id) return "I can only delete my own messages";
        await target.delete();
        return `Deleted message ${input.message_id} from #${channel.name}`;
      } catch (err) {
        return `Failed to delete message: ${err.message}`;
      }
    }

    case "read_messages": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!canReadChannel(channel, message.member)) {
          return "You need View Channel and Read Message History to read messages there.";
        }
        if (!canReadChannel(channel, guild.members?.me)) {
          return "I need View Channel and Read Message History there.";
        }

        const count = Math.min(Math.max(input.count || 10, 1), 100);
        const fetchOpts = { limit: count };
        if (input.before) fetchOpts.before = input.before;

        const messages = await channel.messages.fetch(fetchOpts);
        if (!messages.size) return `No messages found in #${channel.name}`;

        const lines = messages.map((m) => {
          const ts = m.createdAt.toISOString().slice(0, 16).replace("T", " ");
          let line = `[${m.author.username}] (${ts}) [msgId:${m.id}]`;

          // Text content
          if (m.content) line += ` ${m.content.slice(0, 150)}`;

          // Embeds — show titles, descriptions
          if (m.embeds?.length) {
            const embedSummary = m.embeds.map(e => {
              const parts = [];
              if (e.title) parts.push(`title:"${e.title}"`);
              if (e.description) parts.push(`desc:"${e.description.slice(0, 80)}"`);
              if (e.footer?.text) parts.push(`footer:"${e.footer.text.slice(0, 50)}"`);
              return parts.join(", ");
            }).join(" | ");
            line += ` [EMBED: ${embedSummary}]`;
          }

          // Components — show buttons and dropdowns with their options
          if (m.components?.length) {
            const compSummary = m.components.map(row => {
              return row.components.map(c => {
                if (c.type === ComponentType.Button) {
                  return `btn:"${c.label}"`;
                } else if (c.type === ComponentType.StringSelect) {
                  const opts = c.options?.map(o => o.label).join(", ") || "";
                  const mode = c.customId?.includes("exclusive") ? "exclusive" : "multi";
                  return `dropdown(${mode}):[${opts}]`;
                }
                return c.type;
              }).join(", ");
            }).join(" | ");
            line += ` [COMPONENTS: ${compSummary}]`;
          }

          return line;
        });

        return `Messages in #${channel.name} (${messages.size}):\n${spotlight(lines.join("\n"), "channel_message")}`;
      } catch (err) {
        return `Failed to read messages: ${err.message}`;
      }
    }

    case "search_messages": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!canReadChannel(channel, message.member)) {
          return "You need View Channel and Read Message History to search messages there.";
        }
        if (!canReadChannel(channel, guild.members?.me)) {
          return "I need View Channel and Read Message History there.";
        }

        if (!input.keyword) return "A keyword is required to search messages";

        const count = Math.min(Math.max(input.count || 100, 1), 100);
        const messages = await channel.messages.fetch({ limit: count });
        const keyword = input.keyword.toLowerCase();

        const matches = messages.filter(
          (m) => m.content.toLowerCase().includes(keyword)
        );

        if (!matches.size) return `No messages matching "${input.keyword}" in #${channel.name}`;

        const lines = matches.map((m) => {
          const ts = m.createdAt.toISOString().slice(0, 16).replace("T", " ");
          const content = m.content.length > 200
            ? m.content.slice(0, 200) + "..."
            : m.content || "(no text content)";
          return `${m.author.username} (${ts}): ${content}`;
        });

        return `Found ${matches.size} message(s) matching "${input.keyword}" in #${channel.name}:\n${spotlight(lines.join("\n"), "channel_message")}`;
      } catch (err) {
        return `Failed to search messages: ${err.message}`;
      }
    }

    case "pin_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!hasChannelPermission(channel, message.member, PermissionFlagsBits.ManageMessages)) {
          return "You need Manage Messages to pin messages.";
        }
        if (!hasChannelPermission(channel, guild.members?.me, PermissionFlagsBits.ManageMessages)) {
          return "I need Manage Messages to pin messages.";
        }

        const target = await channel.messages.fetch(input.message_id);
        if (!target) return `Couldn't find message with ID ${input.message_id}`;

        await target.pin();
        return `Pinned message ${input.message_id} in #${channel.name}`;
      } catch (err) {
        return `Failed to pin message: ${err.message}`;
      }
    }

    case "unpin_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!hasChannelPermission(channel, message.member, PermissionFlagsBits.ManageMessages)) {
          return "You need Manage Messages to unpin messages.";
        }
        if (!hasChannelPermission(channel, guild.members?.me, PermissionFlagsBits.ManageMessages)) {
          return "I need Manage Messages to unpin messages.";
        }

        const target = await channel.messages.fetch(input.message_id);
        if (!target) return `Couldn't find message with ID ${input.message_id}`;

        await target.unpin();
        return `Unpinned message ${input.message_id} in #${channel.name}`;
      } catch (err) {
        return `Failed to unpin message: ${err.message}`;
      }
    }

    case "list_pins": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!canReadChannel(channel, message.member)) {
          return "You need View Channel and Read Message History to list pins there.";
        }
        if (!canReadChannel(channel, guild.members?.me)) {
          return "I need View Channel and Read Message History there.";
        }

        const pinned = await channel.messages.fetchPinned();
        if (!pinned.size) return `No pinned messages in #${channel.name}`;

        const lines = pinned.map((m) => {
          const ts = m.createdAt.toISOString().slice(0, 16).replace("T", " ");
          const content = m.content.length > 200
            ? m.content.slice(0, 200) + "..."
            : m.content || "(no text content)";
          return `[${m.id}] ${m.author.username} (${ts}): ${content}`;
        });

        return `Pinned messages in #${channel.name} (${pinned.size}):\n${lines.join("\n")}`;
      } catch (err) {
        return `Failed to list pins: ${err.message}`;
      }
    }

    case "react_to_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!canReadChannel(channel, message.member) || !hasChannelPermission(channel, message.member, PermissionFlagsBits.AddReactions)) {
          return "You need View Channel, Read Message History, and Add Reactions there.";
        }
        if (!canReadChannel(channel, guild.members?.me) || !hasChannelPermission(channel, guild.members?.me, PermissionFlagsBits.AddReactions)) {
          return "I need View Channel, Read Message History, and Add Reactions there.";
        }

        const target = await channel.messages.fetch(input.message_id);
        if (!target) return `Couldn't find message with ID ${input.message_id}`;

        await target.react(input.emoji);
        return `Reacted with ${input.emoji} to message ${input.message_id} in #${channel.name}`;
      } catch (err) {
        return `Failed to react: ${err.message}`;
      }
    }

    case "remove_reaction": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_id || input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
        if (!canReadChannel(channel, message.member) || !hasChannelPermission(channel, message.member, PermissionFlagsBits.ManageMessages)) {
          return "You need View Channel, Read Message History, and Manage Messages to remove reactions there.";
        }
        if (!canReadChannel(channel, guild.members?.me) || !hasChannelPermission(channel, guild.members?.me, PermissionFlagsBits.ManageMessages)) {
          return "I need View Channel, Read Message History, and Manage Messages there.";
        }

        const target = await channel.messages.fetch(input.message_id);
        if (!target) return `Couldn't find message with ID ${input.message_id}`;

        const reaction = target.reactions.cache.find((r) => {
          // Match unicode emoji directly or custom emoji by name/identifier
          return r.emoji.toString() === input.emoji
            || r.emoji.name === input.emoji
            || r.emoji.identifier === input.emoji;
        });

        if (!reaction) return `No reaction ${input.emoji} found on that message`;

        await reaction.users.remove(client.user.id);
        return `Removed reaction ${input.emoji} from message ${input.message_id} in #${channel.name}`;
      } catch (err) {
        return `Failed to remove reaction: ${err.message}`;
      }
    }

    // ─── Messaging ───────────────────────────────────────────────────
    case "send_message": {
      input = normalizeSendMessageArgs(input);
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (!canSendToChannel(ch, message.member)) return "You need View Channel and Send Messages in that channel.";
      if (!canSendToChannel(ch, guild.members?.me)) return "I need View Channel and Send Messages in that channel.";
      const hasEmbed = input.embed_title || input.embed_description || input.embed_image || input.embed_fields;
      if (hasEmbed) {
        if (!hasChannelPermission(ch, message.member, PermissionFlagsBits.EmbedLinks)) return "You need Embed Links in that channel.";
        if (!hasChannelPermission(ch, guild.members?.me, PermissionFlagsBits.EmbedLinks)) return "I need Embed Links in that channel.";
        const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, cyan: 0x1abc9c, teal: 0x1abc9c, gold: 0xF1C40F, magenta: 0xE91E63 };
        let color = 0x2b2d31; // default: dark embed (blends with Discord dark mode)
        if (input.embed_color) {
          const lower = input.embed_color.toLowerCase().trim();
          if (NAMED_COLORS[lower]) color = NAMED_COLORS[lower];
          else {
            const parsed = parseInt(lower.replace(/^#|^0x/, ""), 16);
            if (!isNaN(parsed)) color = parsed;
          }
        }
        const embed = new EmbedBuilder().setColor(color);
        if (input.embed_title) embed.setTitle(input.embed_title.substring(0, 256));
        if (input.embed_description) embed.setDescription(input.embed_description.replace(/\\n/g, "\n").substring(0, 4096));
        else if (input.content && input.embed_title) embed.setDescription(input.content.replace(/\\n/g, "\n").substring(0, 4096));
        if (input.embed_image) embed.setImage(input.embed_image);
        if (input.embed_thumbnail) embed.setThumbnail(input.embed_thumbnail);
        if (input.embed_author) embed.setAuthor({ name: input.embed_author.substring(0, 256), iconURL: input.embed_author_icon || undefined });
        if (input.embed_footer) embed.setFooter({ text: input.embed_footer.substring(0, 2048), iconURL: input.embed_footer_icon || undefined });
        if (input.embed_timestamp) embed.setTimestamp();
        if (Array.isArray(input.embed_fields)) {
          const fields = input.embed_fields.slice(0, 25).map(f => ({
            name: String(f.name).replace(/\\n/g, "\n").substring(0, 256),
            value: String(f.value).replace(/\\n/g, "\n").substring(0, 1024),
            inline: !!f.inline,
          }));
          embed.addFields(...fields);
        }

        // Build optional components (buttons + dropdown)
        const components = [];
        const BUTTON_STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger, link: ButtonStyle.Link };

        // Known actions map AI-chosen action names to customIds that existing
        // interactionCreate handlers already route. Extending this list is how
        // you give the AI new functional buttons in custom panels.
        const BUTTON_ACTIONS = {
          open_ticket: "ticket_create",
        };

        if (Array.isArray(input.buttons) && input.buttons.length) {
          for (const b of input.buttons) {
            if (!b.role_id) continue;
            const role = guild.roles.cache.get(b.role_id);
            const roleErr = validateAssignableRole(guild, role, { actor: message.member, actionLabel: "Button role", requireActorManageRoles: true });
            if (roleErr) return roleErr;
          }
          for (let i = 0; i < input.buttons.length; i += 5) {
            const slice = input.buttons.slice(i, i + 5);
            const row = new ActionRowBuilder().addComponents(
              slice.map((b, idx) => {
                const btn = new ButtonBuilder()
                  .setLabel((b.emoji ? `${b.emoji} ` : "") + (b.label || "Button").slice(0, 80))
                  .setStyle(BUTTON_STYLES[b.style] || ButtonStyle.Secondary);
                if (b.style === "link" && b.url) {
                  btn.setURL(b.url);
                } else if (b.action && BUTTON_ACTIONS[b.action]) {
                  btn.setCustomId(BUTTON_ACTIONS[b.action]);
                } else if (b.role_id) {
                  btn.setCustomId(`toggle_role:${b.role_id}`);
                } else {
                  // No handler — tag the customId so our fallback can recognize
                  // and ack it gracefully (instead of Discord showing "This
                  // interaction failed" after the 3s token window expires).
                  btn.setCustomId(`btn_inert:${Date.now()}:${i + idx}`);
                }
                return btn;
              })
            );
            components.push(row);
          }
        }

        if (input.dropdown?.options?.length) {
          const d = input.dropdown;
          for (const opt of d.options.slice(0, 25)) {
            const role = guild.roles.cache.get(opt.role_id);
            const roleErr = validateAssignableRole(guild, role, { actor: message.member, actionLabel: "Dropdown role", requireActorManageRoles: true });
            if (roleErr) return roleErr;
          }
          const exclusive = d.exclusive ?? false;
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`dropdown_role:${exclusive ? "exclusive" : "multi"}`)
            .setPlaceholder(d.placeholder || "Select...")
            .setMinValues(d.min ?? (exclusive ? 1 : 0))
            .setMaxValues(d.max ?? (exclusive ? 1 : d.options.length));
          for (const opt of d.options.slice(0, 25)) {
            const o = new StringSelectMenuOptionBuilder()
              .setLabel(opt.label || "Option")
              .setValue(opt.role_id);
            if (opt.description) o.setDescription(opt.description.slice(0, 100));
            if (opt.emoji) o.setEmoji(opt.emoji);
            menu.addOptions(o);
          }
          components.push(new ActionRowBuilder().addComponents(menu));
        }

        try {
          const sendPayload = { embeds: [embed] };
          if (components.length) sendPayload.components = components;
          // content goes above the embed as plain text (for pings, etc.)
          if (input.content && input.embed_description) sendPayload.content = input.content.substring(0, 2000);
          await ch.send(sendPayload);
        } catch (e) {
          await ch.send(`**${input.embed_title || ""}**\n${input.embed_description || input.content || ""}`).catch(() => {});
          return `Sent as plain text (embed failed: ${e.message})`;
        }
      } else {
        await ch.send((input.content || "").substring(0, 2000));
      }
      return `Sent message to #${ch.name}`;
    }

    case "send_animated_message": {
      const ch = findChannel(guild, input.channel_id || input.channel_name);
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (!canSendToChannel(ch, message.member)) return "You need View Channel and Send Messages in that channel.";
      if (!canSendToChannel(ch, guild.members?.me)) return "I need View Channel and Send Messages in that channel.";
      if (!hasChannelPermission(ch, message.member, PermissionFlagsBits.EmbedLinks)) return "You need Embed Links in that channel.";
      if (!hasChannelPermission(ch, guild.members?.me, PermissionFlagsBits.EmbedLinks)) return "I need Embed Links in that channel.";
      const {
        animateEmbed, typewriterFrames, progressBarFrames, countdownFrames,
        revealFrames, loadingFrames, sparkleFrames, statusFrames,
        giveawayRevealFrames, pollResultFrames, alertFrames,
      } = await import("../../utils/animate.js");

      // Parse color
      const NAMED_COLORS = { red: 0xED4245, blue: 0x3498db, green: 0x57F287, yellow: 0xFEE75C, orange: 0xff8c00, purple: 0x9b59b6, pink: 0xEB459E, white: 0xffffff, black: 0x2b2d31, blurple: 0x5865f2, gold: 0xF1C40F };
      let color = undefined;
      if (input.color) {
        const lower = input.color.toLowerCase().trim();
        if (NAMED_COLORS[lower]) color = NAMED_COLORS[lower];
        else { const p = parseInt(lower.replace(/^#|^0x/, ""), 16); if (!isNaN(p)) color = p; }
      }

      let frames;
      const text = (input.text || "").replace(/\\n/g, "\n");
      switch (input.animation) {
        case "typewriter":
          frames = typewriterFrames(input.title, text, { color });
          break;
        case "progress":
          frames = progressBarFrames(input.title, text, { color });
          break;
        case "countdown":
          frames = countdownFrames(3, input.end_title || "GO!", { color, subtitle: text });
          break;
        case "reveal":
          frames = revealFrames(input.title, text, { color, revealColor: color });
          break;
        case "loading":
          frames = loadingFrames(input.title, { color });
          break;
        case "sparkle":
          frames = sparkleFrames(input.title, text, { color });
          break;
        case "status":
          frames = statusFrames(input.title, text.split("|").map(s => s.trim()), { color });
          break;
        case "giveaway":
          frames = giveawayRevealFrames(input.title, input.winner || "???", { color });
          break;
        case "poll_results":
          if (!Array.isArray(input.poll_options)) return "poll_results needs poll_options array";
          frames = pollResultFrames(input.title, input.poll_options, { color });
          break;
        case "alert":
          frames = alertFrames(input.title, text, { color });
          break;
        default:
          return `Unknown animation type: ${input.animation}`;
      }
      if (!frames?.length) return "No frames generated";
      await animateEmbed(ch, frames, 1000);
      return `Sent animated ${input.animation} embed to #${ch.name}`;
    }

    case "create_thread": {
      const ch = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!ch) return `Couldn't find channel "${input.channel_name}"`;
      if (!canSendToChannel(ch, message.member)) return "You need View Channel and Send Messages in that channel.";
      if (!canSendToChannel(ch, guild.members?.me)) return "I need View Channel and Send Messages in that channel.";
      if (!hasChannelPermission(ch, message.member, PermissionFlagsBits.CreatePublicThreads)) return "You need Create Public Threads in that channel.";
      if (!hasChannelPermission(ch, guild.members?.me, PermissionFlagsBits.CreatePublicThreads)) return "I need Create Public Threads in that channel.";
      const thread = await ch.threads.create({ name: input.name, autoArchiveDuration: parseInt(input.auto_archive) || 1440, reason: `Created ${by}` });
      return `Created thread "${thread.name}" in #${ch.name}`;
    }
  }
}
