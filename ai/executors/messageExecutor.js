// ─── Message Management Executor ────────────────────────────────────────────

const HANDLED = new Set([
  "edit_message", "delete_message", "read_messages", "search_messages",
  "pin_message", "unpin_message", "list_pins",
  "react_to_message", "remove_reaction",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel } = ctx;
  const client = message.client;

  switch (toolName) {
    case "edit_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;
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
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
                if (c.type === 2) { // Button
                  return `btn:"${c.label}"`;
                } else if (c.type === 3) { // StringSelect
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

        return `Messages in #${channel.name} (${messages.size}):\n${lines.join("\n")}`;
      } catch (err) {
        return `Failed to read messages: ${err.message}`;
      }
    }

    case "search_messages": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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

        return `Found ${matches.size} message(s) matching "${input.keyword}" in #${channel.name}:\n${lines.join("\n")}`;
      } catch (err) {
        return `Failed to search messages: ${err.message}`;
      }
    }

    case "pin_message": {
      try {
        const channel = input.channel_name
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
          ? findChannel(guild, input.channel_name)
          : message.channel;
        if (!channel) return `Couldn't find channel "${input.channel_name}"`;

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
  }
}
