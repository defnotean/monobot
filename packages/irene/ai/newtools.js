// ─── New AI Tool Definitions for Irene ──────────────────────────────────────
// Memory, image generation, leveling, and channel management tools

export const NEW_EVERYONE_TOOLS = [
  {
    name: "save_self_fact",
    description:
      "Record a fact about YOURSELF (Irene) — your own identity, preferences, or personal canon. Use when you declare something about yourself that should stay consistent ('my favorite color is lavender', 'i drink tea not coffee', 'im a cat person'). These get injected into your system prompt on every turn so you never contradict your own identity. Different from save_my_take (stances on external topics) — this is who YOU are.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Short declarative fact about yourself. Max 160 chars." },
        category: { type: "string", description: "Optional: 'taste', 'identity', 'quirk', 'misc'." },
      },
      required: ["fact"],
    },
  },
  {
    name: "recall_self_facts",
    description:
      "List facts you've stored about yourself. Use when asked 'whats your favorite X', 'tell me about yourself', or before making a self-declaration.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional filter." },
      },
      required: [],
    },
  },
  {
    name: "forget_self_fact",
    description:
      "Delete one of your own stored self-facts by keyword match.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Keyword(s) to find the fact to forget." },
      },
      required: ["search"],
    },
  },
  {
    name: "save_my_take",
    description:
      "Record YOUR OWN stance/opinion on a topic so you stay consistent across future conversations. Use when you realize you're expressing a genuine opinion about something — a game, artist, food, concept, person, whatever. Next time the topic comes up, you'll be reminded of what you said before so you either hold the line or explicitly acknowledge changing your mind. Don't save weak takes ('idk it's fine') — only save actual stances you'd defend.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What the opinion is ABOUT (short phrase: 'pineapple pizza', 'new arcane season'). Max 120 chars." },
        stance: { type: "string", description: "Your stance: 'positive', 'negative', or 'neutral'." },
        reason: { type: "string", description: "Optional short reason (max 200 chars), in your voice." },
        strength: { type: "number", description: "How strongly you hold this, 0-1. 0.2 = mild, 0.8 = hill you'd die on. Default 0.5." },
      },
      required: ["topic", "stance"],
    },
  },
  {
    name: "recall_my_take",
    description:
      "Look up what YOU previously thought about a topic. Use before expressing an opinion so you stay consistent, or when someone asks 'what do you think about X'. Returns your stored stance, reason, and flip history if you've changed your mind.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic keyword(s) to look up. Leave empty to list your most recent takes." },
      },
      required: [],
    },
  },
  {
    name: "remember_fact",
    description: "Remember a fact about a user for future conversations. Use this when a user shares personal info, preferences, or important details.",
    input_schema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Username or mention of the user" },
        fact: { type: "string", description: "The fact to remember (e.g. 'likes Valorant', 'birthday March 12')" },
        importance: { type: "string", description: "How important: core (identity, deep bonds — never forget), important (preferences, events — keep forever), normal (general), trivial (temporary — can be pruned)" },
      },
      required: ["user", "fact"],
    },
  },
  {
    name: "recall_memories",
    description: "Recall what you remember about a user. If no user specified, recalls all memories for users in the current conversation.",
    input_schema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Username to recall memories for (optional)" },
      },
    },
  },
  {
    name: "forget_memory",
    description: "Forget a specific memory about a user. Use when someone says 'forget that', 'don't remember that', 'delete that memory', etc. Call recall_memories first to find the index, then call this to delete it.",
    input_schema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Username whose memory to forget" },
        index: { type: "number", description: "1-based index of the memory to remove (from recall_memories list)" },
      },
      required: ["user", "index"],
    },
  },
  {
    name: "clear_all_memories",
    description: "Wipe ALL memories about a user. Use when someone says 'forget everything about me', 'clear my data', 'erase all my info', etc. This is permanent.",
    input_schema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Username whose memories to wipe completely" },
      },
      required: ["user"],
    },
  },
  {
    name: "summarize_channel",
    description: "Read and summarize recent messages in a channel. Great for catching up.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: {
          type: "string",
          description: "Channel name to summarize (optional, defaults to current channel)",
        },
        message_count: {
          type: "number",
          description: "Number of recent messages to read (default 50, max 200)",
        },
      },
    },
  },
  {
    name: "generate_image",
    description: "Generate an image from a text description using AI.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image you want to generate" },
        style: {
          type: "string",
          enum: ["realistic", "anime", "cartoon", "pixel", "sketch"],
          description: "Art style for the image (optional)",
        },
      },
      required: ["prompt"],
    },
  },
];

export const NEW_ADMIN_TOOLS = [
  {
    name: "set_level_reward",
    description: "Set a role reward for reaching a level. Users get this role when they hit that level.",
    input_schema: {
      type: "object",
      properties: {
        level: { type: "number", description: "The level number" },
        role_name: { type: "string", description: "Role name to award at this level" },
      },
      required: ["level", "role_name"],
    },
  },
  {
    name: "remove_level_reward",
    description: "Remove the configured role reward for a specific level. Use only when editing leveling rewards, not when removing a user's role.",
    input_schema: {
      type: "object",
      properties: {
        level: { type: "number", description: "The level number to remove reward from" },
      },
      required: ["level"],
    },
  },
  {
    name: "toggle_leveling",
    description: "Enable or disable the server XP/leveling system.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "True to enable, false to disable" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "set_level_channel",
    description: "Set the text channel used for level-up announcements.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name for announcements" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "set_level_ping_roles",
    description: "Set role(s) to ping when someone levels up. Supports multiple roles (comma-separated). Pass 'none' to clear.",
    input_schema: {
      type: "object",
      properties: {
        ping_roles: { type: "string", description: "Role(s) to ping on level-up announcements. Comma-separated for multiple, e.g. 'Level Alerts, XP Pings'. Pass 'none' to clear." },
      },
      required: ["ping_roles"],
    },
  },
  {
    name: "configure_suggestions",
    description: "Set the text channel where user suggestions should be submitted or posted.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name for suggestions" },
      },
      required: ["channel_name"],
    },
  },

  {
    name: "toggle_voice_listen",
    description: "Start or stop listening in a voice channel. When enabled, the bot listens for the wake word (default: 'irene') and responds with voice. The user must be in a voice channel.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"], description: "Start/stop listening or check status" },
        wake_word: { type: "string", description: "Custom wake word (optional, default: irene)" },
      },
      required: ["action"],
    },
  },
  {
    name: "list_invites",
    description: "List all active server invites with their code, channel, inviter, and use count.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "delete_invite",
    description: "Delete a server invite by its invite code.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The invite code to delete" },
      },
      required: ["code"],
    },
  },
  {
    name: "invite_stats",
    description: "View invite tracking data — who invited who, leaderboard of top inviters, or recent joins. Tracks which invite link each member used to join and whether they stayed or left.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["leaderboard", "history", "user"], description: "leaderboard = top inviters with counts. history = recent joins with invite info. user = who a specific person invited" },
        count: { type: "integer", description: "Number of results to return (default 10, max 50)" },
        username: { type: "string", description: "For action='user' — the username/mention to look up" },
      },
      required: ["action"],
    },
  },
  {
    name: "set_server_settings",
    description: "Modify server settings like name, description, verification level, notifications, content filter, AFK timeout, system channel, or rules channel.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New server name" },
        description: { type: "string", description: "New server description" },
        verification_level: { type: "string", enum: ["none", "low", "medium", "high", "very_high"], description: "Verification level for new members" },
        default_notifications: { type: "string", enum: ["all_messages", "only_mentions"], description: "Default notification setting for new members" },
        content_filter: { type: "string", enum: ["disabled", "members_without_roles", "all_members"], description: "Explicit content filter level" },
        afk_timeout: { type: "string", enum: ["60", "300", "900", "1800", "3600"], description: "AFK timeout in seconds (60, 300, 900, 1800, or 3600)" },
        system_channel: { type: "string", description: "Channel name for system messages" },
        rules_channel: { type: "string", description: "Channel name for server rules" },
      },
    },
  },
  {
    name: "set_server_icon",
    description: "Change the Discord server icon from an image URL. Do not use this for Irene's bot avatar or server-specific profile picture; use set_server_avatar for that.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the image to set as the server icon" },
      },
      required: ["url"],
    },
  },
  {
    name: "edit_message",
    description: "Edit a message previously sent by the bot, identified by message ID and channel.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel the message is in" },
        message_id: { type: "string", description: "ID of the message to edit" },
        content: { type: "string", description: "New message content" },
      },
      required: ["channel_name", "message_id", "content"],
    },
  },
  {
    name: "delete_message",
    description: "Delete one of Irene's own messages by ID. Use this to remove old/broken embeds, dropdowns, or role pickers before recreating them. Can only delete messages sent by the bot.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel the message is in" },
        message_id: { type: "string", description: "The message ID to delete (get this from read_messages)" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "read_messages",
    description: "Read recent messages from a channel — includes embed titles, descriptions, buttons, dropdown options, and message IDs. Use this to see what's already in a channel before making changes. Essential for fixing existing dropdowns or embeds.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to read messages from" },
        count: { type: "number", description: "Number of messages to read (default 10, max 100)" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "search_messages",
    description: "Search messages in a channel by keyword.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to search in" },
        keyword: { type: "string", description: "Keyword or phrase to search for" },
        count: { type: "number", description: "Number of messages to scan (default 100)" },
      },
      required: ["channel_name", "keyword"],
    },
  },
  {
    name: "pin_message",
    description: "Pin a message by its ID in a channel.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel the message is in" },
        message_id: { type: "string", description: "ID of the message to pin" },
      },
      required: ["channel_name", "message_id"],
    },
  },
  {
    name: "unpin_message",
    description: "Unpin a message by its ID in a channel.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel the message is in" },
        message_id: { type: "string", description: "ID of the message to unpin" },
      },
      required: ["channel_name", "message_id"],
    },
  },
  {
    name: "list_pins",
    description: "List all pinned messages in a channel.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to list pinned messages from" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "react_to_message",
    description: "Add Irene's plain emoji reaction to a message. Do not use this for reaction roles; use add_reaction_role or setup_reaction_roles for role assignment.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel the message is in" },
        message_id: { type: "string", description: "ID of the message to react to" },
        emoji: { type: "string", description: "Emoji to react with (e.g. '👍' or custom emoji name)" },
      },
      required: ["channel_name", "message_id", "emoji"],
    },
  },
  {
    name: "remove_reaction",
    description: "Remove Irene's plain emoji reaction from a message. Do not use this to remove a reaction-role mapping; use remove_reaction_role for that.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel the message is in" },
        message_id: { type: "string", description: "ID of the message to remove the reaction from" },
        emoji: { type: "string", description: "Emoji to remove (e.g. '👍' or custom emoji name)" },
      },
      required: ["channel_name", "message_id", "emoji"],
    },
  },
  {
    name: "view_audit_log",
    description: "View recent audit log entries for the server.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of entries to fetch (default 20)" },
        action_type: { type: "string", description: "Filter by action type (e.g. 'MEMBER_BAN_ADD', 'CHANNEL_CREATE')" },
        user: { type: "string", description: "Filter by user who performed the action" },
      },
    },
  },
  {
    name: "list_members",
    description: "List server members with their roles and join dates.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of members to list (default 100, max 1000)" },
      },
    },
  },
];
