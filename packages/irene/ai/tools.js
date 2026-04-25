// ─── Irene's AI Tool Definitions ────────────────────────────────────────────
// All the actions Irene can perform via natural language

import { NEW_ADMIN_TOOLS, NEW_EVERYONE_TOOLS } from "./newtools.js";

export const ADMIN_TOOLS = [
  // ─── Channel Management ─────────────────────────────────────────────
  {
    name: "create_channel",
    description: "Create a new text or voice channel. Can set it as private for specific users only.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Channel name" },
        type: { type: "string", enum: ["text", "voice", "stage", "forum"], description: "Channel type (default: text)" },
        category: { type: "string", description: "Category name to put the channel under (optional)" },
        private: { type: "boolean", description: "If true, only specified users/roles can see this channel" },
        allowed_users: { type: "array", items: { type: "string" }, description: "Usernames that can access a private channel" },
        allowed_roles: { type: "array", items: { type: "string" }, description: "Role names that can access a private channel" },
        topic: { type: "string", description: "Channel topic/description (optional)" },
        nsfw: { type: "boolean", description: "Mark as NSFW (optional)" },
        slowmode: { type: "number", description: "Slowmode in seconds (optional)" },
        user_limit: { type: "number", description: "Max users for voice channels (optional, 0 = unlimited)" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_channel",
    description: "Delete a channel from the server",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Channel name to delete" } },
      required: ["name"],
    },
  },
  {
    name: "nuke_channel",
    description: "Nuke/reset a channel — clones it and deletes the old one, wiping ALL messages. Defaults to current channel.",
    input_schema: {
      type: "object",
      properties: { channel_name: { type: "string", description: "Channel name to nuke (optional — defaults to current)" } },
    },
  },
  {
    name: "rename_channel",
    description: "Rename a channel",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Current channel name" },
        new_name: { type: "string", description: "New name" },
      },
      required: ["channel_name", "new_name"],
    },
  },
  {
    name: "set_channel_topic",
    description: "Set a text channel's topic/description",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name (optional — defaults to current)" },
        topic: { type: "string", description: "The new topic" },
      },
      required: ["topic"],
    },
  },
  {
    name: "set_slowmode",
    description: "Set slowmode on a channel",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name (optional — defaults to current)" },
        seconds: { type: "number", description: "Slowmode seconds (0 = off, max 21600)" },
      },
      required: ["seconds"],
    },
  },
  {
    name: "lock_channel",
    description: "Lock a channel — members can't send messages",
    input_schema: {
      type: "object",
      properties: { channel_name: { type: "string", description: "Channel name (optional — defaults to current)" } },
    },
  },
  {
    name: "unlock_channel",
    description: "Unlock a channel — members can send messages again",
    input_schema: {
      type: "object",
      properties: { channel_name: { type: "string", description: "Channel name (optional — defaults to current)" } },
    },
  },
  {
    name: "move_channel",
    description: "Move a channel to a different category",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to move" },
        category_name: { type: "string", description: "Destination category" },
      },
      required: ["channel_name", "category_name"],
    },
  },
  {
    name: "clone_channel",
    description: "Clone/duplicate a channel with all its settings and permissions",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to clone" },
        new_name: { type: "string", description: "Name for the clone (optional)" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "set_channel_permissions",
    description: "Set per-channel permission overrides for a role or user. This is how you lock channels to specific roles, hide channels, restrict who can send/speak, etc. Note: this sets CHANNEL-LEVEL overrides only, not global role permissions (those are set in Server Settings > Roles manually). Use null to reset/inherit a permission from the role's default.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name to set permissions on (defaults to current channel)" },
        target: { type: "string", description: "Role name or username to set permissions for" },
        target_type: { type: "string", enum: ["user", "role"], description: "Whether target is a user or role" },
        reset: { type: "boolean", description: "If true, removes all permission overrides for this target on this channel (reset to default)" },
        allow_view: { type: "boolean", description: "Can they see the channel? (null = inherit)" },
        allow_send: { type: "boolean", description: "Can they send messages? (null = inherit)" },
        allow_read_history: { type: "boolean", description: "Can they read message history?" },
        allow_react: { type: "boolean", description: "Can they add reactions?" },
        allow_attach: { type: "boolean", description: "Can they attach files and upload?" },
        allow_embed_links: { type: "boolean", description: "Can they embed links?" },
        allow_use_ext_emoji: { type: "boolean", description: "Can they use external emojis?" },
        allow_mention_everyone: { type: "boolean", description: "Can they @everyone / @here?" },
        allow_manage_messages: { type: "boolean", description: "Can they delete/pin other people's messages?" },
        allow_use_slash: { type: "boolean", description: "Can they use slash commands / bot interactions?" },
        allow_connect: { type: "boolean", description: "Can they connect to a voice channel?" },
        allow_speak: { type: "boolean", description: "Can they speak in voice?" },
        allow_stream: { type: "boolean", description: "Can they stream / go live?" },
        allow_move_members: { type: "boolean", description: "Can they move other members between voice channels?" },
      },
      required: ["target", "target_type"],
    },
  },
  // ─── Category Management ────────────────────────────────────────────
  {
    name: "create_category",
    description: "Create a new channel category",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Category name" } },
      required: ["name"],
    },
  },
  {
    name: "delete_category",
    description: "Delete a category (channels inside will become uncategorized)",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Category name" } },
      required: ["name"],
    },
  },
  // ─── Role Management ────────────────────────────────────────────────
  {
    name: "set_role_permissions",
    description: "Set global server-wide permissions for a role — what that role can do anywhere in the server by default. These are the same permissions shown in Server Settings > Roles. Pass true to grant, false to deny, or omit to leave unchanged.",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Name of the role to edit" },
        view_channels:       { type: "boolean", description: "Can see channels" },
        send_messages:       { type: "boolean", description: "Can send messages" },
        read_history:        { type: "boolean", description: "Can read message history" },
        embed_links:         { type: "boolean", description: "Can embed links" },
        attach_files:        { type: "boolean", description: "Can attach files" },
        add_reactions:       { type: "boolean", description: "Can add reactions" },
        use_ext_emoji:       { type: "boolean", description: "Can use external emojis" },
        use_slash_commands:  { type: "boolean", description: "Can use slash commands and bot interactions" },
        mention_everyone:    { type: "boolean", description: "Can @everyone / @here" },
        manage_messages:     { type: "boolean", description: "Can delete/pin others messages" },
        manage_channels:     { type: "boolean", description: "Can create/edit/delete channels" },
        manage_roles:        { type: "boolean", description: "Can manage roles below their own" },
        manage_guild:        { type: "boolean", description: "Can change server name, icon, settings" },
        kick_members:        { type: "boolean", description: "Can kick members" },
        ban_members:         { type: "boolean", description: "Can ban members" },
        timeout_members:     { type: "boolean", description: "Can timeout members" },
        view_audit_log:      { type: "boolean", description: "Can view the audit log" },
        connect_voice:       { type: "boolean", description: "Can connect to voice channels" },
        speak_voice:         { type: "boolean", description: "Can speak in voice channels" },
        stream:              { type: "boolean", description: "Can stream / go live" },
        move_members:        { type: "boolean", description: "Can move members between voice channels" },
        mute_members:        { type: "boolean", description: "Can server-mute members in voice" },
        deafen_members:      { type: "boolean", description: "Can server-deafen members in voice" },
        administrator:       { type: "boolean", description: "Full administrator access — grants everything. Use carefully." },
      },
      required: ["role_name"],
    },
  },
  {
    name: "create_role",
    description: "Create a new role",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Role name" },
        color: { type: "string", description: "Hex color like #ff0000" },
        hoist: { type: "boolean", description: "Show separately in member list" },
        mentionable: { type: "boolean", description: "Can be @mentioned by anyone" },
        icon: { type: "string", description: "Role icon — a single Unicode emoji (e.g. '🔥') or an image URL. Requires server Boost Level 2+." },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_role",
    description: "Delete a role",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Role name to delete" } },
      required: ["name"],
    },
  },
  {
    name: "edit_role",
    description: "Edit an existing role's properties",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Current role name" },
        new_name: { type: "string", description: "New name (optional)" },
        color: { type: "string", description: "New color hex (optional)" },
        hoist: { type: "boolean", description: "Show separately (optional)" },
        mentionable: { type: "boolean", description: "Mentionable (optional)" },
        icon: { type: "string", description: "Role icon — a single Unicode emoji (e.g. '🔥') or an image URL. Pass 'none' to remove the icon. Requires server Boost Level 2+." },
      },
      required: ["name"],
    },
  },
  {
    name: "set_role_icons",
    description: "Set icons on multiple existing roles at once. Use list_roles first to see current roles and their icons. Each entry takes a role name and an icon (Unicode emoji, image URL, or 'none' to clear). Requires server Boost Level 2+.",
    input_schema: {
      type: "object",
      properties: {
        roles: {
          type: "array",
          description: "List of roles to update",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Role name" },
              icon: { type: "string", description: "Unicode emoji (e.g. '👑'), image URL, or 'none' to clear" },
            },
            required: ["name", "icon"],
          },
        },
      },
      required: ["roles"],
    },
  },
  {
    name: "reorder_roles",
    description: "Reorder roles in the server hierarchy by setting their positions. Higher position number = higher in the list. Use get_role_permissions or list_roles first to see current positions, then set new ones. Useful for fixing color role display (color roles must be above the member's other roles to show).",
    input_schema: {
      type: "object",
      properties: {
        roles: {
          type: "array",
          description: "List of roles with their new positions",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Role name" },
              position: { type: "number", description: "New position (1 = bottom, higher = further up the list)" },
            },
            required: ["name", "position"],
          },
        },
      },
      required: ["roles"],
    },
  },
  {
    name: "give_role",
    description: "Give a role to a user",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" },
        role_name: { type: "string", description: "Role to give" },
      },
      required: ["username", "role_name"],
    },
  },
  {
    name: "remove_role",
    description: "Remove a role from a user",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" },
        role_name: { type: "string", description: "Role to remove" },
      },
      required: ["username", "role_name"],
    },
  },
  {
    name: "mass_role",
    description: "Give or remove a role from all members, or all members with a specific role",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Role to give/remove" },
        action: { type: "string", enum: ["give", "remove"], description: "Give or remove" },
        filter_role: { type: "string", description: "Only affect members who have this role (optional)" },
      },
      required: ["role_name", "action"],
    },
  },
  // ─── Moderation ─────────────────────────────────────────────────────
  {
    name: "ban_user",
    description: "Ban a user from the server",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to ban" },
        reason: { type: "string", description: "Reason" },
        delete_messages: { type: "number", description: "Days of messages to delete (0-7)" },
      },
      required: ["username"],
    },
  },
  {
    name: "tempban",
    description: "Temporarily ban a user for a specified duration. They'll be automatically unbanned when the time expires. Use for serious but temporary infractions.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "User to temp-ban" },
        duration: { type: "string", description: "How long to ban — e.g. 30m, 2h, 1d, 1w" },
        reason: { type: "string", description: "Reason for the ban" },
      },
      required: ["username", "duration"],
    },
  },
  {
    name: "kick_user",
    description: "Kick a user from the server",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to kick" },
        reason: { type: "string", description: "Reason" },
      },
      required: ["username"],
    },
  },
  {
    name: "warn_user",
    description: "Warn a user (stored in database)",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" },
        reason: { type: "string", description: "Reason" },
      },
      required: ["username", "reason"],
    },
  },
  {
    name: "timeout_user",
    description: "Timeout a user for a duration",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" },
        duration: { type: "string", enum: ["1m", "5m", "10m", "30m", "1h", "6h", "12h", "1d", "3d", "7d"], description: "Duration" },
        reason: { type: "string", description: "Reason" },
      },
      required: ["username", "duration"],
    },
  },
  {
    name: "untimeout_user",
    description: "Remove an active Discord timeout from a user so they can chat again. Use when someone says things like 'untimeout X', 'remove the timeout from X', 'let X talk again', or 'undo the timeout'.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "User to untimeout" },
        reason: { type: "string", description: "Reason for removing the timeout" },
      },
      required: ["username"],
    },
  },
  {
    name: "unban_user",
    description: "Unban a user so they can rejoin the server. Prefer user_id since banned users aren't in the guild cache anymore. Also clears any active temp-ban record for this user. Use when someone says 'unban X', 'lift X's ban', or 'let X back in'.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID (18-20 digit number) — preferred" },
        username: { type: "string", description: "Past username or tag — only used when user_id is not available" },
        reason: { type: "string", description: "Reason for the unban" },
      },
    },
  },
  {
    name: "unmute_user",
    description: "Remove the 'Muted' role from a user (reverses the role-based mute from /mute). For Discord timeouts use untimeout_user instead.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "User to unmute" },
        reason: { type: "string", description: "Reason" },
      },
      required: ["username"],
    },
  },
  {
    name: "remove_warning",
    description: "Delete a single warning by its numeric ID. Use after warn_user's output or a warnings listing surfaces the ID. To wipe every warning for a user, use clear_warnings.",
    input_schema: {
      type: "object",
      properties: {
        warning_id: { type: "number", description: "Numeric warning ID to remove" },
        reason: { type: "string", description: "Reason for removing the warning" },
      },
      required: ["warning_id"],
    },
  },
  {
    name: "clear_warnings",
    description: "Delete ALL warnings for a user in this server. Destructive — prefer remove_warning for a single one. Use when someone says 'clear X's warnings' or 'wipe X's record'.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "User whose warnings should be cleared" },
        reason: { type: "string", description: "Reason" },
      },
      required: ["username"],
    },
  },
  {
    name: "lockdown_server",
    description: "Lock all text channels so only admins can send messages. Use during raids or emergencies. Auto-unlocks after 10 minutes.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Reason for lockdown" } },
    },
  },
  {
    name: "unlock_server",
    description: "Lift server lockdown and restore normal send permissions for everyone.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Reason for unlocking" } },
    },
  },
  {
    name: "find_message",
    description: "Search for messages in a channel and return their IDs. Use this to find a specific user's first/last message, a message containing certain text, etc. Returns message IDs that you can then pass to purge_messages (before_message_id / after_message_id). Always use this FIRST when the user says 'delete everything above X's message' — find the message ID automatically, then purge with it. NEVER ask the user to copy a message ID manually.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to search (defaults to current)" },
        from_user:    { type: "string", description: "Only messages from this user" },
        contains:     { type: "string", description: "Message must contain this text (case-insensitive)" },
        position:     { type: "string", enum: ["first", "last"], description: "'first' = oldest matching message found (scan up to 500), 'last' = most recent matching message. Default: 'first'" },
        limit:        { type: "number", description: "How many messages to scan (1–500, default 200)" },
      },
    },
  },
  {
    name: "purge_messages",
    description: "Delete messages from a channel with powerful filtering. Can filter by user, date, content type, and message position. Fetches up to 500 messages in batches. Use before_message_id/after_message_id to anchor around a specific message (e.g. 'delete everything above X's message'). Use before_date/after_date for date ranges. Messages < 14 days are bulk-deleted instantly; older messages are deleted one by one (slower but works). NEVER say you can't delete old messages.",
    input_schema: {
      type: "object",
      properties: {
        count:                    { type: "number", description: "Max messages to scan/delete (1–500, default 100). The tool fetches in batches of 100." },
        channel_name:             { type: "string", description: "Channel to purge (defaults to current channel)" },
        from_user:                { type: "string", description: "Only delete messages FROM this specific user" },
        exclude_user:             { type: "string", description: "Delete everyone's messages EXCEPT this user's" },
        only_keep_media_from_user:{ type: "string", description: "Keep ONLY media posts from this user — delete everything else" },
        content_type:             { type: "string", enum: ["all", "media", "text"], description: "'media' = only attachments/images/videos, 'text' = only text, 'all' = everything (default)" },
        before_message_id:        { type: "string", description: "Only delete messages BEFORE (above) this message ID. Use to delete everything above a specific message." },
        after_message_id:         { type: "string", description: "Only delete messages AFTER (below) this message ID. Use to delete everything below a specific message." },
        before_date:              { type: "string", description: "Only delete messages sent BEFORE this date (ISO 8601 or 'YYYY-MM-DD'). E.g. '2025-01-15'" },
        after_date:               { type: "string", description: "Only delete messages sent AFTER this date. E.g. '2025-03-01'" },
        contains:                 { type: "string", description: "Only delete messages whose content includes this text (case-insensitive)" },
        not_contains:             { type: "string", description: "Exclude messages containing this text" },
        has_links:                { type: "boolean", description: "If true, only delete messages containing URLs. If false, only delete messages without URLs." },
        is_pinned:                { type: "boolean", description: "If true, only delete pinned messages. If false (default behavior), skip pinned messages to protect them." },
      },
      required: ["count"],
    },
  },
  {
    name: "set_nickname",
    description: "Change a user's nickname in the server",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" },
        nickname: { type: "string", description: "New nickname (empty to reset)" },
      },
      required: ["username", "nickname"],
    },
  },
  {
    name: "move_user_to_voice",
    description: "Move a user to a different voice channel",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" },
        channel_name: { type: "string", description: "Voice channel to move them to" },
      },
      required: ["username", "channel_name"],
    },
  },
  {
    name: "disconnect_user_from_voice",
    description: "Disconnect a user from their current voice channel",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username" } },
      required: ["username"],
    },
  },
  // ─── Server Settings ────────────────────────────────────────────────
  {
    name: "set_welcome_channel",
    description: "Set the welcome channel for new members",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name" },
        welcome_message: { type: "string", description: "Custom message ({user}, {server}, {membercount})" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "customize_welcome",
    description: "Customize EVERY visual aspect of the welcome embed — color, title, description, fields, images, author, footer, text outside the embed, field labels, and more. All params are optional — only pass what you want to change. Placeholders: {user} = @mention, {username} = display name, {server} = server name, {membercount} = count, {age} = account age, {joined} = join date, {member_number} = #N. Call send_test_welcome afterward to preview.",
    input_schema: {
      type: "object",
      properties: {
        reset:            { type: "boolean",  description: "Set to true to reset ALL customizations back to defaults" },
        color:            { type: "string",   description: "Embed border color. Hex (#FF0000) or named: white, black, red, green, blue, yellow, orange, purple, pink, cyan, blurple" },
        show_title:       { type: "boolean",  description: "Show or hide the embed title entirely" },
        title:            { type: "string",   description: "Embed title text. Supports all placeholders. Pass 'default' to restore." },
        title_url:        { type: "string",   description: "Makes the title a clickable link. Pass 'none' to remove." },
        description:      { type: "string",   description: "Main welcome message body. Supports all placeholders. Pass 'default' to restore." },
        content:          { type: "string",   description: "Text sent OUTSIDE the embed (visible above it). Supports all placeholders. Pass 'none' to clear." },
        show_thumbnail:   { type: "boolean",  description: "Show the new member's avatar as a thumbnail (top-right)" },
        thumbnail_url:    { type: "string",   description: "Custom thumbnail image URL. Pass 'none' to revert to user avatar." },
        show_banner:      { type: "boolean",  description: "Show a large hero image at the bottom of the embed (off by default)" },
        banner_url:       { type: "string",   description: "Custom image URL for the hero banner. Pass 'none' to use server banner." },
        show_author:      { type: "boolean",  description: "Show the author line (server name + icon by default)" },
        author_name:      { type: "string",   description: "Custom author text. Supports all placeholders. Pass 'default' for server name." },
        author_icon_url:  { type: "string",   description: "Custom author icon URL. Pass 'none' for server icon." },
        author_url:       { type: "string",   description: "Makes the author name a clickable link. Pass 'none' to remove." },
        show_footer:      { type: "boolean",  description: "Show footer at the bottom" },
        footer_text:      { type: "string",   description: "Custom footer text. Supports all placeholders. Pass 'default' for server name." },
        footer_icon_url:  { type: "string",   description: "Custom footer icon URL. Pass 'none' for server icon." },
        show_timestamp:   { type: "boolean",  description: "Show timestamp in the footer area" },
        show_member_field:{ type: "boolean",  description: "Show the member count inline field" },
        show_age_field:   { type: "boolean",  description: "Show the account age inline field" },
        show_joined_field:{ type: "boolean",  description: "Show the 'On Discord since' inline field" },
        member_field_name:{ type: "string",   description: "Custom label for the member count field (default: '🔢 Member')" },
        age_field_name:   { type: "string",   description: "Custom label for the account age field (default: '📅 Account Age')" },
        joined_field_name:{ type: "string",   description: "Custom label for the joined date field (default: '🗓️ On Discord')" },
        ping_user:        { type: "boolean",  description: "Ping/mention the new member so they get a notification" },
        ping_roles:       { type: "string",   description: "Role(s) to ping when a new member joins. Comma-separated for multiple, e.g. 'Greeters, Staff'. Pass 'none' to clear." },
        extra_fields: {
          type: "array",
          description: "Additional custom fields to add below the default ones. Pass an empty array [] to clear all extra fields.",
          items: {
            type: "object",
            properties: {
              name:   { type: "string",  description: "Field title" },
              value:  { type: "string",  description: "Field value. Supports all placeholders." },
              inline: { type: "boolean", description: "Display inline alongside other fields" },
            },
            required: ["name", "value"],
          },
        },
      },
    },
  },
  {
    name: "set_access_role",
    description: "Set which role gets automatically assigned to anyone who uses Irene. Defaults to a role named 'Irene' if not configured.",
    input_schema: {
      type: "object",
      properties: { role_name: { type: "string", description: "Role name to assign to Irene users" } },
      required: ["role_name"],
    },
  },
  {
    name: "setup_verification",
    description: "Set up a verification system for the server. Sets a verified role — only users WITH this role can see and access channels. Automatically locks down ALL channels to require the verified role, EXCEPT channels you mark as public (rules, verification, welcome). Use when someone says 'setup verification', 'set verified role', 'lock down the server', 'restrict unverified users'. This will: 1) set the verified role, 2) deny @everyone ViewChannel on ALL channels, 3) allow the verified role ViewChannel on ALL channels, 4) keep specified channels public for unverified users.",
    input_schema: {
      type: "object",
      properties: {
        verified_role: { type: "string", description: "Name of the verified role (e.g. 'Verified', 'Member')" },
        public_channels: { type: "string", description: "Comma-separated channel names that unverified users CAN see (e.g. 'rules, verification, welcome'). All other channels will be locked." },
      },
      required: ["verified_role"],
    },
  },
  {
    name: "trust_user",
    description: "Grant a user full admin-level access to Irene's tools — they can use all commands as if they were an admin. Only the server owner or existing admins should do this.",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to trust" } },
      required: ["username"],
    },
  },
  {
    name: "untrust_user",
    description: "Remove a user's trusted status — they'll go back to regular member access.",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to remove from trusted list" } },
      required: ["username"],
    },
  },
  {
    name: "list_trusted_users",
    description: "List all users who have been explicitly trusted with AI and Bot control on this server.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_log_channel",
    description: "Set the log channel for moderation actions AND message events (edits, deletes). All server logs go here.",
    input_schema: {
      type: "object",
      properties: { channel_name: { type: "string", description: "Channel name" } },
      required: ["channel_name"],
    },
  },
  {
    name: "set_autorole",
    description: "Auto-assign a role to new members when they join the server, or disable it. Pass 'none' or 'off' for role_name to disable autorole.",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Role name to auto-assign. Pass 'none', 'off', or 'disable' to turn off autorole." },
      },
      required: ["role_name"],
    },
  },
  // ─── Server Whitelist (bot-owner only) ───────────────────────────
  {
    name: "whitelist_server",
    description: "Add a server to the bot's whitelist so it's allowed to stay there. The user can provide a Discord invite link (discord.gg/xxx), a guild ID, or a server name to look up. This resolves the invite to show server info before adding. BOT OWNER ONLY.",
    input_schema: {
      type: "object",
      properties: {
        invite_or_id: { type: "string", description: "Discord invite link (discord.gg/xxx or full URL), or a guild ID" },
      },
      required: ["invite_or_id"],
    },
  },
  {
    name: "unwhitelist_server",
    description: "Remove a server from the whitelist. The bot will leave that server on its next check. BOT OWNER ONLY.",
    input_schema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The guild ID to remove, or the server name (will fuzzy match from the current whitelist)" },
      },
      required: ["guild_id"],
    },
  },
  {
    name: "list_whitelist",
    description: "Show all whitelisted servers. BOT OWNER ONLY.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_dm_results",
    description: "Toggle whether the bot DMs users with tool/command results after executing actions. Defaults to OFF (no DMs). Use when admin says 'stop DMing people', 'enable DMs', 'don't DM results', etc.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true = DM users with results after tool use, false = don't DM anyone (default)" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "configure_patch_news",
    description: "Set up game patch notes and GPU driver update notifications. Add or remove game feeds, set the notification channel, set ping roles. Supports MULTIPLE ping roles (comma-separated). Available feeds: valorant, league, fortnite, minecraft, apex, overwatch, nvidia, amd. Or provide a custom RSS URL.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post patch notes in" },
        add_feed: { type: "string", description: "Game name from the known list (valorant, league, etc) or a custom RSS URL to add" },
        remove_feed: { type: "string", description: "Feed name to remove" },
        ping_roles: { type: "string", description: "Role(s) to ping for ALL patch notes. Comma-separated for multiple, e.g. 'Patch Notes, Gaming News'" },
        feed_ping_roles: { type: "string", description: "Role(s) to ping for a SPECIFIC feed (use with add_feed). Comma-separated for multiple. Overrides global ping_roles for that feed." },
        list: { type: "boolean", description: "List currently configured feeds and their ping roles" },
      },
    },
  },
  {
    name: "configure_twitch",
    description: "Set up Twitch live stream notifications. Add streamers to watch, set notification channel, ping roles. Supports MULTIPLE ping roles (comma-separated). Each streamer can have their own ping roles, or use defaults for all. Anyone can configure this, not just admins. Use 'test' to send a preview.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post live notifications in" },
        add_streamer: { type: "string", description: "Twitch username to add" },
        remove_streamer: { type: "string", description: "Twitch username to remove" },
        ping_roles: { type: "string", description: "Default role(s) to ping when ANY streamer goes live. Comma-separated for multiple, e.g. 'Twitch Pings, Stream Alerts'" },
        ping_role: { type: "string", description: "DEPRECATED — use ping_roles instead. Single default role to ping" },
        streamer_ping_roles: { type: "string", description: "Role(s) to ping for a SPECIFIC streamer (use with add_streamer). Comma-separated for multiple, e.g. 'Ninja Fan, Stream Alerts'" },
        streamer_ping_role: { type: "string", description: "DEPRECATED — use streamer_ping_roles instead. Single role for a specific streamer" },
        list: { type: "boolean", description: "List configured streamers and their ping roles" },
        test: { type: "string", description: "Send a test notification for this Twitch username" },
      },
    },
  },
  {
    name: "configure_youtube",
    description: "Set up YouTube video notifications. Add or remove YouTube channels to watch, set which Discord channel to post in, set ping roles. Supports MULTIPLE ping roles (comma-separated). Requires the YouTube channel ID (24-char string, NOT the @handle).",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Discord channel to post video notifications in (required when adding a feed)" },
        add_channel: { type: "string", description: "YouTube channel ID to add (24 chars, e.g. UCxxxxxxxxxxxxxxxxxxxxxxxx)" },
        remove_channel: { type: "string", description: "YouTube channel ID to remove" },
        ping_roles: { type: "string", description: "Role(s) to ping for this YouTube feed. Comma-separated for multiple, e.g. 'YouTube Pings, Video Alerts'" },
        list: { type: "boolean", description: "List currently configured YouTube feeds and their ping roles" },
      },
    },
  },
  {
    name: "configure_github",
    description: "Set up GitHub commit notifications. Add or remove repos to watch, set which Discord channel to post in, set ping roles. Supports MULTIPLE ping roles (comma-separated). Repo format: owner/repo.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Discord channel to post commit notifications in (required when adding a feed)" },
        add_repo: { type: "string", description: "GitHub repo to add, format: owner/repo (e.g. EatingMoss/cool-project)" },
        remove_repo: { type: "string", description: "GitHub repo to remove (owner/repo format)" },
        branch: { type: "string", description: "Git branch to watch (default: main)" },
        ping_roles: { type: "string", description: "Role(s) to ping for this repo feed. Comma-separated for multiple, e.g. 'Dev Pings, Commit Alerts'" },
        list: { type: "boolean", description: "List currently configured GitHub feeds and their ping roles" },
      },
    },
  },
  {
    name: "configure_giveaway_pings",
    description: "Set role(s) to ping when a new giveaway starts. Supports multiple roles (comma-separated). Pass 'none' to clear.",
    input_schema: {
      type: "object",
      properties: {
        ping_roles: { type: "string", description: "Role(s) to ping when giveaways start. Comma-separated for multiple, e.g. 'Giveaway Pings, Events'. Pass 'none' to clear." },
      },
      required: ["ping_roles"],
    },
  },
  {
    name: "toggle_tts",
    description: "Enable or disable text-to-speech in a voice channel. When enabled, the bot joins the VC and reads messages typed in the VC chat aloud using Gemini AI voices. Use when someone says 'enable TTS', 'join and read messages', 'speak in VC', 'read chat out loud', etc.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Voice channel name (defaults to user's current VC)" },
        enabled: { type: "boolean", description: "true to enable TTS, false to disable" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "set_tts_voice",
    description: "Change the TTS voice. Voices: Kore (bright, default), Puck (upbeat), Charon (deep/masculine), Zephyr (breathy), Fenrir (smooth), Enceladus (calm), Algieba (warm), Despina (soft), Leda (gentle), Aoede (clear), Callirrhoe (melodic), Umbriel (rich), Tethys (steady), Proteus (bold), Ariel (light).",
    input_schema: {
      type: "object",
      properties: {
        voice: { type: "string", description: "Voice name (e.g. 'Kore', 'Charon', 'Puck')" },
      },
      required: ["voice"],
    },
  },
  {
    name: "say_tts",
    description: "Make the bot say something out loud in the user's voice channel. The bot joins the VC if needed. Use when someone says 'say X out loud', 'announce in VC', 'speak this', 'tell everyone X', etc.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak out loud" },
      },
      required: ["text"],
    },
  },
  {
    name: "configure_birthdays",
    description: "Set up or update the birthday announcement system — channel, optional role, and custom message",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel where birthday announcements are posted" },
        role_name:    { type: "string", description: "Role name to give members on their birthday for 24 h (optional)" },
        message:      { type: "string", description: "Custom birthday message. Supports {user}, {username}, {server}. Pass 'default' to reset to default." },
        disable:      { type: "boolean", description: "Set to true to disable birthday announcements (clears channel)" },
      },
    },
  },
  {
    name: "setup_role_picker",
    description: "Post a BUTTON-based self-role picker with a styled embed. Users click buttons to toggle roles. CRITICAL: ALWAYS call list_roles FIRST to see what roles actually exist — NEVER assume role names. Only use roles from the list, or set create_if_missing: true. DESIGN TIPS: use embed_color to match the server's aesthetic (dark=#2b2d31, pastel=#e8c4f0, etc). Use separator lines (── or ━━) in descriptions. Add emoji to button labels. For dropdowns use setup_dropdown_roles. For REACTION/EMOJI roles, use setup_reaction_roles instead.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post the picker in" },
        title: { type: "string", description: "Embed title — use emoji for flair (e.g. '⊹ ˚ Roles' or '✦ Notification Roles')" },
        description: { type: "string", description: "Embed body — use \\n for newlines, decorative lines (━━━━━━━━━━), and spacing for a clean look" },
        embed_color: { type: "string", description: "Hex color for embed sidebar (#2b2d31 for dark, #f47fff for pink, etc.)" },
        embed_image: { type: "string", description: "Banner image URL at bottom of embed (for aesthetic headers/dividers)" },
        embed_thumbnail: { type: "string", description: "Small image in top-right corner" },
        embed_footer: { type: "string", description: "Footer text (e.g. 'click to toggle')" },
        roles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Exact name of an existing role (or one to create)" },
              emoji: { type: "string", description: "Button emoji — always use one for visual consistency" },
              description: { type: "string", description: "Short label shown on the button (optional, defaults to role name)" },
              style: { type: "string", enum: ["primary", "secondary", "success", "danger"], description: "Button color: primary=blurple, secondary=gray, success=green, danger=red. Default: secondary" },
              create_if_missing: { type: "boolean", description: "Create the role if it doesn't exist (default false)" },
            },
            required: ["name"],
          },
        },
      },
      required: ["channel_name", "title", "roles"],
    },
  },
  {
    name: "setup_dropdown_roles",
    description: "Post a DROPDOWN/SELECT MENU role picker. Users pick roles from a dropdown — cleaner than buttons for 5+ roles. Supports multi-select (toggle) or exclusive (one at a time). Max 25 roles per dropdown. CRITICAL: ALWAYS call list_roles FIRST to see what roles actually exist — NEVER assume role names. Only use roles that are in the list. If a role doesn't exist, set create_if_missing: true OR ask the user. DESIGN RULES: ALWAYS use embed_color (#2b2d31 dark modern, or match server palette). Add emoji to role options using COMMON emoji only (🎮 🎵 🎨 ❤️ 🔥 ⭐ etc — avoid obscure Unicode like ⚧️ which Discord rejects). Add a short description to each role. Use decorative Unicode in the embed title (⊹ ˚ ✦ ━━ etc). Use \\n spacing and separator lines (━━━━━━━━━━) in the embed description. Set a custom placeholder. The embed should look premium — minimal, aesthetic, intentional.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post in" },
        title: { type: "string", description: "Embed title — use emoji for flair" },
        description: { type: "string", description: "Embed body — use \\n for newlines, decorative lines for a clean look" },
        placeholder: { type: "string", description: "Placeholder text shown in the closed dropdown (e.g. 'Pick your roles...')" },
        embed_color: { type: "string", description: "Hex color for embed sidebar (#2b2d31 for dark, #f47fff for pink, etc.)" },
        embed_image: { type: "string", description: "Banner image URL at bottom of embed" },
        embed_thumbnail: { type: "string", description: "Small image in top-right corner" },
        embed_footer: { type: "string", description: "Footer text" },
        exclusive: { type: "boolean", description: "If true, selecting a new role removes the old one (like color roles). Default: false (multi-select toggle)" },
        min_roles: { type: "integer", description: "Minimum roles to select (default: 0)" },
        max_roles: { type: "integer", description: "Maximum roles to select at once (default: all)" },
        roles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Exact role name (or one to create)" },
              emoji: { type: "string", description: "Emoji shown next to option in the dropdown" },
              description: { type: "string", description: "Short description shown under the role name in the dropdown (max 100 chars)" },
              create_if_missing: { type: "boolean", description: "Create the role if it doesn't exist (default false)" },
            },
            required: ["name"],
          },
        },
      },
      required: ["channel_name", "title", "roles"],
    },
  },
  {
    name: "setup_color_roles",
    description: "Create a color role picker with buttons — makes the roles, then posts a styled embed. One color at a time; clicking again removes it. DESIGN TIP: pick a pastel or muted palette over harsh primaries for a modern look. Use decorative emoji in titles.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post the color picker in" },
        colors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Color name — aesthetic names are better (e.g. 'Lavender' not 'Purple', 'Rose' not 'Pink')" },
              hex: { type: "string", description: "Hex color code (e.g. #E8C4F0 for lavender, #FFB7C5 for rose)" },
              emoji: { type: "string", description: "Emoji for the button (e.g. 🪻 for lavender, 🌸 for rose)" },
            },
            required: ["name", "hex"],
          },
          description: "List of colors to offer",
        },
        title: { type: "string", description: "Embed title with emoji flair (default: '🎨 Pick a Color')" },
        description: { type: "string", description: "Embed description — use \\n and decorative lines for clean layout" },
        embed_color: { type: "string", description: "Hex color for embed sidebar" },
        embed_image: { type: "string", description: "Banner image URL (aesthetic headers/dividers)" },
        embed_footer: { type: "string", description: "Footer text" },
      },
      required: ["channel_name", "colors"],
    },
  },
  {
    name: "set_ghost_ping_channels",
    description: "Configure which channels get a ghost-ping (a quick @mention that auto-deletes after 1.5s) when a new member joins the server. Useful for making new members briefly aware of important channels like #rules, #roles, #info. The ping shows up as a notification for them but gets deleted so the channel stays clean.",
    input_schema: {
      type: "object",
      properties: {
        channel_names: { type: "array", items: { type: "string" }, description: "Channel names or IDs to ghost-ping new members in. Pass an empty array to disable." },
      },
      required: ["channel_names"],
    },
  },
  {
    name: "toggle_seasonal_colors",
    description: "Enable or disable automatic seasonal color role rotation. When enabled, color roles (slots 1-8) automatically change their hex values and names to match the current season. Palettes: Spring Bloom (Mar-May, pastels), Summer Heat (Jun-Aug, vibrant), Autumn Warmth (Sep-Nov, earthy), Winter Frost (Dec-Feb, icy). Special events: Halloween (Oct 15-31), Christmas (December), Valentine's (Feb 7-14). Requires color roles to be set up first via setup_color_roles.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true to enable seasonal rotation, false to disable" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "preview_seasonal_palette",
    description: "Preview any seasonal color palette without applying it. Shows all 8 colors with hex codes. Use to show users what the palettes look like before enabling seasonal rotation.",
    input_schema: {
      type: "object",
      properties: {
        palette: { type: "string", enum: ["spring", "summer", "fall", "winter", "halloween", "christmas", "valentines", "current"], description: "Which palette to preview. 'current' shows whichever is active right now." },
      },
      required: ["palette"],
    },
  },
  {
    name: "force_seasonal_rotation",
    description: "Force an immediate seasonal color rotation. Useful after enabling seasonal colors or to manually trigger a palette change. Only works if seasonal colors are enabled and color roles exist.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_create_vc_channel",
    description: "Set up the 'join to create' voice channel. When someone joins it, the bot automatically creates a personal voice channel for them with full owner controls (rename, user limit, kick). The channel auto-deletes when empty. NOTE: If the user asks you to create the trigger channel itself, be sure to name it EXACTLY what they requested instead of defaulting to 'Create VC'.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Name of the voice channel people join to trigger VC creation (e.g. '➕ Create VC')" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "set_vc_template",
    description: "Set the name template for newly created temp VCs. Full AVC-compatible template system. Variables: @@creator@@ or {creator} (display name), @@game_name@@ or {game} (game being played, vanishes if none), {game|Fallback Text} or @@game_name|Fallback Text@@ (game, but uses Fallback Text if not playing), @@server_name@@ or {server} (server name), {stream|Fallback Text} (Twitch name if streaming), @@num@@ (user count), @@num_others@@ (others excluding creator), @@nato@@ (NATO phonetic: Alpha/Bravo/...). Numbering: ## (#1, #2...), $# (1, 2...), +# (I, II...), $0# (01, 02...), $00# (001...), $000# (0001...). Singular/plural: <<mouse/mice>> uses @@num@@, <<mouse\\mice>> uses @@num_others@@. Random word: [[Squad/Team/Party]]. Examples: '#1 {game}' → '#1 Minecraft' (or '#1' if no game) | '{game|Chill Zone}' → 'Valorant' (or 'Chill Zone' if no game) | '@@nato@@ [[Squad/Team/Party]]' → 'Alpha Squad'",
    input_schema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Template string" },
      },
      required: ["template"],
    },
  },
  {
    name: "set_vc_default_limit",
    description: "Set the default user limit for newly created temp VCs. 0 = unlimited.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max users per VC (0 = unlimited)" },
      },
      required: ["limit"],
    },
  },

  {
    name: "set_vc_naming_mode",
    description: "Change how temp VCs are named (only applies when no custom template is set). Modes: 'smart' (default) — shows creator's name like 'Valorant • eating's vc'. 'anonymous' — no person's name, numbered like 'Valorant • VC #1'. 'random' — random server-themed names like 'The Lounge • Alpha' or 'Chill Zone • Bravo'. Use when someone says 'don't show names in VCs', 'make VC names random', 'remove my name from VC', etc.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["smart", "anonymous", "random"], description: "Naming mode: smart (person's name), anonymous (numbered), random (themed names)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "toggle_vc_rich_presence",
    description: "Toggle whether extra game details (like 'In Combat' or 'Playing Competitive') are added to voice channel names. When true: 'Marvel Rivals: In Combat • VC'. When false: 'Marvel Rivals • VC'. Disable this if they only want the clean game name shown.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true = show game details, false = only show main game name" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "set_afk_channel",
    description: "Set the AFK voice channel — users who self-deafen for too long get auto-moved there",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Voice channel to use as AFK channel" },
        timeout_minutes: { type: "number", description: "Minutes of inactivity before the AFK check fires (default: 30)" },
      },
      required: ["channel_name"],
    },
  },
  // ─── Messaging / Content ────────────────────────────────────────────
  {
    name: "send_message",
    description: "Send a rich embed or message to a channel — optionally with BUTTONS and/or a DROPDOWN attached. This is the most versatile tool: combine embeds + buttons + dropdowns in ONE message for info panels, role pickers, navigation menus, welcome screens, etc. Chain multiple send_message calls to build entire channel layouts. Embed descriptions support FULL Discord markdown: # headers, -# subtext, **bold**, > blockquotes, [masked links](url), ||spoilers||, `code`, and decorative unicode separators. Use \\n for newlines.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to send to" },
        content: { type: "string", description: "Plain text above the embed (optional if embed is used)" },
        embed_title: { type: "string", description: "Embed title — keep short and iconic, use decorative unicode (⊹ ✦ ꒰꒱ ──)" },
        embed_description: { type: "string", description: "Main embed body — supports full Discord markdown: # ## ### headers, -# subtext (small muted text), **bold**, > blockquotes, [text](url) masked links, ||spoilers||, `code`. Use \\n for newlines, \\n\\n for spacing. Use decorative separators (━━━, ── ⊹ ──) and unicode bullets (✦ » ▸ ›) for visual hierarchy" },
        embed_color: { type: "string", description: "Hex color (#2b2d31 for dark/borderless, #1a1a2e for midnight, #e8c4f0 for lavender, #ffb7c5 for rose, etc.) or named: red, green, blue, purple, pink, blurple, gold, cyan, teal" },
        embed_image: { type: "string", description: "Large image URL at bottom of embed" },
        embed_thumbnail: { type: "string", description: "Small image URL in top-right corner" },
        embed_author: { type: "string", description: "Author name shown at top of embed" },
        embed_author_icon: { type: "string", description: "Small icon next to author name (URL)" },
        embed_footer: { type: "string", description: "Footer text at bottom of embed" },
        embed_footer_icon: { type: "string", description: "Small icon next to footer (URL)" },
        embed_fields: { type: "array", description: "Array of fields: [{name, value, inline?}]", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } }, required: ["name", "value"] } },
        embed_timestamp: { type: "boolean", description: "Show timestamp on embed (default false for clean look)" },
        buttons: { type: "array", description: "Optional buttons to attach (max 25, 5 per row). Use for role toggles, link buttons, navigation, etc. Functional buttons REQUIRE one of `role_id`, `url`, or `action` — a button with only label+style+emoji won't do anything when clicked and will show 'This interaction failed' to the user.", items: { type: "object", properties: { label: { type: "string", description: "Button text" }, style: { type: "string", enum: ["primary", "secondary", "success", "danger", "link"], description: "primary=blurple, secondary=gray, success=green, danger=red, link=gray+opens URL" }, role_id: { type: "string", description: "For role toggle buttons: the role ID to toggle. Button customId is auto-set to toggle_role:<id>" }, url: { type: "string", description: "For link buttons only: the URL to open" }, action: { type: "string", enum: ["open_ticket"], description: "Wire the button to a built-in action. 'open_ticket' opens a support ticket (requires setup_ticket to have been run first). Use this when posting custom-styled ticket panels — otherwise the button will be inert." }, emoji: { type: "string", description: "Emoji on the button" } }, required: ["label", "style"] } },
        dropdown: { type: "object", description: "Optional dropdown/select menu to attach below the embed", properties: { placeholder: { type: "string", description: "Placeholder text (e.g. '⊹ pick your roles')" }, exclusive: { type: "boolean", description: "If true, one choice at a time (removes old). Default: false (multi-select)" }, min: { type: "integer", description: "Min selections (default: 0)" }, max: { type: "integer", description: "Max selections (default: all options)" }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, role_id: { type: "string", description: "Role ID — selecting this option toggles the role" }, emoji: { type: "string" }, description: { type: "string", description: "Short text under the label (max 100 chars)" } }, required: ["label", "role_id"] } } }, required: ["options"] },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "send_animated_message",
    description: "Send an ANIMATED embed that plays through frames in a channel. Use this for dramatic reveals, announcements, giveaway winners, countdowns, progress updates, and anything that deserves visual flair. Animation types: typewriter (text appears chunk by chunk), progress (bar fills 0→100%), countdown (3..2..1..GO!), reveal (suspenseful ... → content), loading (spinner), sparkle (materializes with ✦ effect), status (multi-step checklist), giveaway (drumroll → winner), poll_results (animated bar chart), alert (pulsing attention grab). Each animation plays over 3-5 frames with ~1 second between frames.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to send the animated embed in" },
        animation: { type: "string", enum: ["typewriter", "progress", "countdown", "reveal", "loading", "sparkle", "status", "giveaway", "poll_results", "alert"], description: "Animation style to use" },
        title: { type: "string", description: "Embed title" },
        text: { type: "string", description: "Main content text (what gets revealed/typed/shown). Use \\n for newlines. For status animation, separate steps with | (pipe)" },
        color: { type: "string", description: "Hex color (#2b2d31, #e8c4f0, etc.) — affects the embed accent bar" },
        end_title: { type: "string", description: "For countdown: custom end text instead of 'GO!'. For giveaway: not used" },
        winner: { type: "string", description: "For giveaway animation: the winner's @mention or name" },
        poll_options: { type: "array", description: "For poll_results: [{name, votes, emoji?}]", items: { type: "object", properties: { name: { type: "string" }, votes: { type: "number" }, emoji: { type: "string" } }, required: ["name", "votes"] } },
      },
      required: ["channel_name", "animation", "title"],
    },
  },
  {
    name: "create_thread",
    description: "Create a thread in a channel",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Thread name" },
        channel_name: { type: "string", description: "Channel to create thread in (optional — defaults to current)" },
        auto_archive: { type: "string", enum: ["60", "1440", "4320", "10080"], description: "Auto-archive after minutes: '60' (1h), '1440' (1d), '4320' (3d), '10080' (7d)" },
      },
      required: ["name"],
    },
  },
  // ─── Emoji Management ───────────────────────────────────────────────
  {
    name: "add_emoji",
    description: "Add a custom emoji to the server from a URL",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Emoji name (no spaces)" },
        url: { type: "string", description: "Image URL for the emoji" },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "remove_emoji",
    description: "Remove a custom emoji from the server",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Emoji name" } },
      required: ["name"],
    },
  },
  // ─── Invites ────────────────────────────────────────────────────────
  {
    name: "create_invite",
    description: "Create a server invite link",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to create invite for (optional — defaults to current)" },
        max_uses: { type: "number", description: "Max uses (0 = unlimited)" },
        max_age: { type: "number", description: "Expires after seconds (0 = never). 3600=1h, 86400=1d, 604800=7d" },
        temporary: { type: "boolean", description: "Temporary membership (kicked when they go offline unless given a role)" },
      },
    },
  },
  // ─── Custom Commands ────────────────────────────────────────────────
  {
    name: "create_custom_command",
    description: "Create a custom !command. Fully customizable embed with title, description, color, image, thumbnail, footer, URL, and fields. Supports placeholders: {user}, {username}, {server}, {membercount}, {channel}.",
    input_schema: {
      type: "object",
      properties: {
        trigger:      { type: "string",  description: "Trigger word (without !) — users type !trigger" },
        description:  { type: "string",  description: "What this command does (internal, not shown to users)" },
        response:     { type: "string",  description: "Response text or embed description. Supports {user}, {username}, {server}, {membercount}, {channel}" },
        embed_title:  { type: "string",  description: "Embed title (makes it an embed instead of plain text)" },
        embed_color:  { type: "string",  description: "Embed sidebar color. Hex (#FF0000) or name: white, black, red, blue, green, etc" },
        embed_url:    { type: "string",  description: "Makes the embed title a clickable link" },
        embed_image:  { type: "string",  description: "Large image URL at the bottom of the embed" },
        embed_thumbnail: { type: "string", description: "Small image URL in the top-right corner" },
        embed_footer: { type: "string",  description: "Footer text at the bottom" },
        embed_author: { type: "string",  description: "Author name shown above the title" },
        embed_author_icon: { type: "string", description: "Author icon URL (small, next to author name)" },
        role_to_give:   { type: "string",  description: "Role to give on use (optional)" },
        role_to_remove: { type: "string",  description: "Role to remove on use (optional)" },
        admin_only:     { type: "boolean", description: "Restrict to admins (default: false)" },
        auto_delete:    { type: "boolean", description: "Delete trigger message (default: false)" },
      },
      required: ["trigger", "description", "response"],
    },
  },
  {
    name: "edit_custom_command",
    description: "Edit any aspect of an existing custom command — text, embed, color, image, thumbnail, footer, etc",
    input_schema: {
      type: "object",
      properties: {
        trigger:           { type: "string",  description: "Command trigger to edit" },
        response:          { type: "string",  description: "New response text / embed description" },
        cmd_description:   { type: "string",  description: "Internal description" },
        embed_title:       { type: "string",  description: "Embed title. Pass 'none' to remove embed and use plain text" },
        embed_color:       { type: "string",  description: "Embed sidebar color. Hex (#FF0000) or name: white, red, blue, etc" },
        embed_url:         { type: "string",  description: "Makes title clickable. Pass 'none' to remove" },
        embed_image:       { type: "string",  description: "Large image URL. Pass 'none' to remove" },
        embed_thumbnail:   { type: "string",  description: "Small thumbnail URL. Pass 'none' to remove" },
        embed_footer:      { type: "string",  description: "Footer text. Pass 'none' to remove" },
        embed_author:      { type: "string",  description: "Author name. Pass 'none' to remove" },
        embed_author_icon: { type: "string",  description: "Author icon URL. Pass 'none' to remove" },
        role_to_give:      { type: "string",  description: "Role to give" },
        role_to_remove:    { type: "string",  description: "Role to remove" },
        admin_only:        { type: "boolean", description: "Restrict to admins" },
        auto_delete:       { type: "boolean", description: "Delete trigger message" },
      },
      required: ["trigger"],
    },
  },
  {
    name: "delete_custom_command",
    description: "Delete a custom command",
    input_schema: {
      type: "object",
      properties: { trigger: { type: "string", description: "Command trigger to delete" } },
      required: ["trigger"],
    },
  },
  {
    name: "list_custom_commands",
    description: "List all custom commands",
    input_schema: { type: "object", properties: {} },
  },
  // ─── New QOL Tools ─────────────────────────────────────────────────────
  {
    name: "set_dm_welcome",
    description: "Configure a DM welcome message sent to new members when they join",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Enable or disable the DM welcome" },
        message: { type: "string", description: "Welcome message (supports {server}, {user}, {membercount})" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "set_leave_channel",
    description: "Set the channel and message for leave notifications when members leave the server",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post leave messages in" },
        message: { type: "string", description: "Leave message (supports {username}, {user}, {server}, {membercount})" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "set_server_avatar",
    description: "Change the bot's profile picture specifically for this server. Use this when a user attaches an image and asks you to use it as your server profile picture / pfp / avatar. Pass the image URL from the [Attached image URL(s)] line in their message.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "The direct URL of the image to use as the server avatar (from the attachment URL in the user message)" },
      },
      required: ["image_url"],
    },
  },
  {
    name: "set_server_banner",
    description: "Change the bot's server profile banner for this server. Use this when a user attaches an image and asks you to use it as your banner. Pass the image URL from the [Attached image URL(s)] line in their message.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "The direct URL of the image to use as the server banner (from the attachment URL in the user message)" },
      },
      required: ["image_url"],
    },
  },
  {
    name: "set_server_persona",
    description: "Change the bot's name and personality for this entire server. Use this when an admin asks to rename the bot, give it a different persona (e.g. 'Gremlin.exe', 'HAL 9000', 'Karen'), or change how it behaves server-wide. Pass null for personality to auto-generate from name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New name for the bot in this server (e.g. 'Gremlin.exe'). Pass null to reset to default." },
        personality: { type: "string", description: "Full replacement personality prompt. Leave absent or null to auto-generate based on the name using the default template." },
        reset: { type: "boolean", description: "Set to true to wipe the custom persona and revert to default Irene." },
      },
    },
  },
  {
    name: "set_channel_personality",
    description: "Set a custom personality/context for the bot in a specific channel. She'll adjust her behavior based on this context.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel name (defaults to current channel)" },
        prompt: { type: "string", description: "Custom context/personality prompt for this channel (leave empty to clear)" },
      },
    },
  },
  {
    name: "set_bad_words",
    description: "Set the list of words to automatically filter/delete in the server",
    input_schema: {
      type: "object",
      properties: {
        words: { type: "array", items: { type: "string" }, description: "List of words to filter (case-insensitive, whole-word match)" },
      },
      required: ["words"],
    },
  },
  {
    name: "set_escalation",
    description: "Configure automatic escalation when a user reaches a certain number of warnings (auto-mute, auto-kick, auto-ban)",
    input_schema: {
      type: "object",
      properties: {
        mute_at: { type: "number", description: "Auto-timeout at this many warnings (null to disable)" },
        kick_at: { type: "number", description: "Auto-kick at this many warnings (null to disable)" },
        ban_at: { type: "number", description: "Auto-ban at this many warnings (null to disable)" },
      },
    },
  },
  {
    name: "setup_stats_channels",
    description: "Create voice channels that display live server stats (member count, online count, bot count)",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category to put the stats channels in (optional)" },
      },
    },
  },
  {
    name: "setup_reaction_roles",
    description: "Post an embed message with emoji REACTION roles — users react with emojis to get roles. Supports both multi-select (pick many) and exclusive mode (pick one, like color roles). Use this when the user says 'reaction roles', 'emoji roles', 'react roles', or specifies emojis. Reaction roles CAN be exclusive — set exclusive: true for color roles etc.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post the reaction role message in" },
        title: { type: "string", description: "Embed title (e.g. 'Pick a Color')" },
        description: { type: "string", description: "Embed description (e.g. 'React to get a role!')" },
        exclusive: { type: "boolean", description: "If true, users can only have ONE role from this set (like color roles). Picking a new one removes the old one. Default: false (multi-select)" },
        roles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              emoji: { type: "string", description: "The emoji to react with (e.g. '🖤', '❤️')" },
              role_name: { type: "string", description: "Role name to assign when reacted" },
              create_if_missing: { type: "boolean", description: "Create the role if it doesn't exist" },
            },
            required: ["emoji", "role_name"],
          },
        },
      },
      required: ["channel_name", "title", "roles"],
    },
  },
  {
    name: "add_reaction_role",
    description: "Add a single reaction role to an EXISTING message AND react to it with the emoji. Also use this when asked to add reactions to an existing message for roles. Use find_message to locate the message if needed — NEVER ask the user for a message ID.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "ID of the message to add the reaction role to" },
        emoji: { type: "string", description: "Emoji to react with (e.g. '✅' or ':emoji_name:')" },
        role_name: { type: "string", description: "Role to give when reacted" },
        exclusive: { type: "boolean", description: "If true, picking this role removes all other roles from the same message (for color roles etc). Default: true for color/single-pick roles." },
      },
      required: ["message_id", "emoji", "role_name"],
    },
  },
  {
    name: "remove_reaction_role",
    description: "Remove a reaction role from a message",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "ID of the message" },
        emoji: { type: "string", description: "Emoji to remove" },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "setup_starboard",
    description: "Set up a starboard channel where popular messages (with enough ⭐ reactions) get posted",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to post starred messages in" },
        threshold: { type: "number", description: "Number of ⭐ reactions needed to get posted (default: 3)" },
      },
      required: ["channel_name"],
    },
  },
  ...NEW_ADMIN_TOOLS,
  // ─── Voice & Auto-Responder Tools ─────────────────────────────────────
  {
    name: "voice_leaderboard",
    description: "Show voice channel activity leaderboard — who's spent the most time in VC. Use when someone asks 'voice leaderboard', 'who's in VC the most', 'vc stats'.",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "How many users to show (default 10)" } } },
  },
  {
    name: "create_auto_responder",
    description: "Create an auto-responder that triggers when someone says a specific word/phrase. Use when someone says 'when someone says X, respond with Y', 'auto respond to X'.",
    input_schema: { type: "object", properties: { trigger: { type: "string", description: "Word or phrase to trigger on" }, response: { type: "string", description: "What to respond with" } }, required: ["trigger", "response"] },
  },
  {
    name: "list_auto_responders",
    description: "List all auto-responders in this server. Use when someone says 'list auto responders', 'what auto responses are set up'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "delete_auto_responder",
    description: "Delete an auto-responder by its trigger phrase. Use when someone says 'remove auto responder for X', 'delete the X auto response'.",
    input_schema: { type: "object", properties: { trigger: { type: "string", description: "Trigger phrase to remove" } }, required: ["trigger"] },
  },
  {
    name: "server_milestones",
    description: "Check server milestones and celebrations. Use when someone asks 'milestones', 'server achievements', 'how many members'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "toggle_auto_responders",
    description: "Enable or disable the auto-responder system for this server. Use when someone says 'disable auto responders', 'turn off auto responses', 'enable auto responders'.",
    input_schema: { type: "object", properties: { enabled: { type: "boolean", description: "true to enable, false to disable" } }, required: ["enabled"] },
  },
  {
    name: "toggle_twin_chat",
    description: "Enable or disable twin sister chat (Irene and Eris talking to each other) in this server. Use when someone says 'disable twin chat', 'stop the twins talking', 'enable twin chat'.",
    input_schema: { type: "object", properties: { enabled: { type: "boolean", description: "true to enable, false to disable" } }, required: ["enabled"] },
  },
  {
    name: "toggle_voice_tracking",
    description: "Enable or disable voice time tracking for this server. Use when someone says 'disable voice tracking', 'turn off vc stats', 'enable voice tracking'.",
    input_schema: { type: "object", properties: { enabled: { type: "boolean", description: "true to enable, false to disable" } }, required: ["enabled"] },
  },
  {
    name: "toggle_invite_filter",
    description: "Enable or disable the anti-invite link filter. When enabled, Discord invite links from non-admin users are automatically deleted. Same-server invites are allowed.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "sticky_message",
    description: "Set a sticky message in a channel. The message will always appear at the bottom — it gets re-sent whenever new messages are posted. Use for rules, announcements, or important info that should always be visible.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to set sticky in" },
        content: { type: "string", description: "Plain text content (optional if using embed)" },
        embed_title: { type: "string", description: "Embed title (optional)" },
        embed_description: { type: "string", description: "Embed description with \\n for newlines" },
        embed_color: { type: "string", description: "Hex color (#2b2d31 for dark, etc)" },
        embed_footer: { type: "string", description: "Footer text" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "remove_sticky",
    description: "Remove a sticky message from a channel",
    input_schema: {
      type: "object",
      properties: { channel_name: { type: "string", description: "Channel to remove sticky from" } },
      required: ["channel_name"],
    },
  },
  {
    name: "manage_giveaway",
    description: "Directs users to the /giveaway slash command for managing giveaways. Giveaways require interactive button flows and precise timers that need the slash command interface.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_roles_by_category",
    description: "List all server roles that match a given category, based on their ACTUAL Discord permissions (not role names). Use this when the admin says something vague like 'give mods access' or 'who are the staff here' — you'll get a clean list of the roles that actually carry that power, ignoring cosmetic roles that just happen to be named similar things. Categories: 'admin' (Administrator or ManageGuild), 'moderator' (Ban/Kick/Timeout/ManageRoles/ManageChannels), 'helper' (ManageMessages/MuteMembers/ViewAuditLog etc.), 'bot' (integration roles), 'everyone' (@everyone), 'cosmetic' (no dangerous perms). Meta-categories: 'staff' (admin + moderator), 'trusted' (admin + moderator + helper).",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "One of: admin, moderator, helper, bot, everyone, cosmetic, staff, trusted.",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "learn_rules_from_channel",
    description: "Read a server's rules channel and extract individual rules into the auto-mod rules engine. Use this when an admin says things like 'learn the rules from #rules', 'check #rules-and-info and remember our rules', 'go look at #rules', or 'take a look at our rules channel'. Reads the last 50 messages from the channel, asks the AI to identify each distinct rule with severity (low/medium/high), and stores them. Doesn't enable enforcement — that's a separate /rules enable step the admin runs after reviewing. Admin-only.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: {
          type: "string",
          description: "The rules channel name (e.g. 'rules', '#rules', 'rules-and-info') or ID.",
        },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "setup_ticket",
    description: "Configure the ticket system. PREFER THE INTERACTIVE FLOW: if the admin hasn't specified every detail, tell them to run `/ticket setup` for a button-driven wizard — it has a channel picker for the category, role pickers for view/ping, a modal for custom welcome text, and a 'Post Panel' button. You only need to call THIS tool directly when the admin has given you explicit values to save, or when they ask you to post a custom-styled panel via send_message (in which case set the button's action to 'open_ticket'). If the admin says something vague like 'set up tickets' without specifying category, view role, ping role, or welcome text — ASK them which knobs they want OR point them at `/ticket setup`. Don't silently pick defaults for them. By default, new tickets are visible ONLY to the opener and Irene — staff access is expected to come from the ticket category's permissions. All fields here are optional; omitted fields keep their current value so you can iterate (e.g. call once with `view_roles`, again with `welcome_description`). Pass an empty array (`[]`) to CLEAR a roles setting. Pass the string 'reset' to clear welcome title/description. Pass `post_panel: true` to also (re)post the open-ticket panel in the category's open-ticket channel.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Category name or ID where tickets should be created. Omit to keep current setting or auto-create a 'TICKETS' category if none exists.",
        },
        view_roles: {
          type: "array",
          items: { type: "string" },
          description: "PINNED role names or IDs granted view+send access on every new ticket. This is a STATIC list — if you want tickets to auto-include any future role with mod permissions, use `view_auto_category` instead (or in addition). Empty array `[]` clears the pinned list. Omit to leave unchanged.",
        },
        ping_roles: {
          type: "array",
          items: { type: "string" },
          description: "PINNED role names or IDs mentioned in the welcome message on new tickets. Static list. Use `ping_auto_category` for dynamic auto-resolution. Empty array `[]` clears. Omit to leave unchanged.",
        },
        view_auto_category: {
          type: "string",
          description: "DYNAMIC view access — resolve this category at ticket-creation time and auto-grant view+send to every matching role. Good when the admin says things like 'give mods access' and you want it to keep working if they add another mod role later. Values: 'admin', 'moderator', 'helper', 'staff' (admin+moderator), 'trusted' (admin+moderator+helper). Pass 'none' or 'reset' to clear. Omit to leave unchanged.",
        },
        ping_auto_category: {
          type: "string",
          description: "DYNAMIC ping — mentions all roles in this category on open, resolved fresh each time. Same values as view_auto_category. Pass 'none'/'reset' to clear. Omit to leave unchanged.",
        },
        welcome_title: {
          type: "string",
          description: "Custom title for the welcome embed inside new tickets. Use the exact string 'reset' to clear and go back to the default. Omit to leave unchanged.",
        },
        welcome_description: {
          type: "string",
          description: "Custom description for the welcome embed. '{user}' is substituted with the opener's mention. Use the exact string 'reset' to clear. Omit to leave unchanged.",
        },
        welcome_color: {
          type: "string",
          description: "Hex color for the welcome embed — e.g. '#5865F2' or '5865F2'. Use 'reset' to clear. Omit to leave unchanged.",
        },
        panel_title: {
          type: "string",
          description: "Custom title for the PANEL embed (the message with the 'Open Ticket' button). Use 'reset' to clear. Omit to leave unchanged.",
        },
        panel_description: {
          type: "string",
          description: "Custom description for the PANEL embed. Use 'reset' to clear. Omit to leave unchanged.",
        },
        panel_color: {
          type: "string",
          description: "Hex color for the PANEL embed. Use 'reset' to clear. Omit to leave unchanged.",
        },
        panel_button_label: {
          type: "string",
          description: "Label on the panel's button (default 'Open Ticket'). Use 'reset' to clear. Omit to leave unchanged.",
        },
        panel_button_emoji: {
          type: "string",
          description: "Emoji on the panel's button (default '🎫'). Can be a unicode emoji or a custom emoji like '<:name:id>'. Use 'reset' to clear. Omit to leave unchanged.",
        },
        panel_channel: {
          type: "string",
          description: "Channel name or ID where the open-ticket panel should be posted. Independent from the ticket category — category controls where TICKETS live, this controls where the 'Open Ticket' BUTTON MESSAGE lives. Use 'auto' (or 'reset') to fall back to creating/using '#open-ticket' under the ticket category. Omit to leave unchanged.",
        },
        ticket_types: {
          type: "array",
          description: "Multiple ticket TYPES — each renders as its own button on the panel and routes to its own category. Use this when the admin wants e.g. Support tickets in one category, Reports in another, Appeals in a third. Pass an empty array `[]` to remove all types (panel falls back to a single 'Open Ticket' button using the global category). Omit to leave unchanged. Each type has: key (unique lowercase id, like 'support'), label (button text), emoji (optional), category (name or ID — where tickets of this type land; falls back to the global category if not set), style (Primary/Secondary/Success/Danger).",
          items: {
            type: "object",
            properties: {
              key:      { type: "string", description: "Unique identifier, lowercase, 1–50 chars, letters/digits/underscore/dash only (e.g. 'support', 'report', 'appeal')." },
              label:    { type: "string", description: "Button label shown on the panel (max 80 chars)." },
              emoji:    { type: "string", description: "Button emoji — unicode like '🎫' or custom like '<:name:id>' (optional)." },
              category: { type: "string", description: "Category name or ID where tickets of this type are created. Falls back to the global ticket category if omitted/invalid." },
              style:    { type: "string", enum: ["Primary", "Secondary", "Success", "Danger"], description: "Button color (default Primary)." },
            },
            required: ["key", "label"],
          },
        },
        remove_ticket_types: {
          type: "array",
          items: { type: "string" },
          description: "List of type keys to remove individually (e.g. ['report', 'appeal']). Use this when the admin wants to remove specific types without touching the rest. Unknown keys are silently ignored.",
        },
        post_panel: {
          type: "boolean",
          description: "If true, post (or UPDATE IN PLACE if one's already live) the open-ticket panel message. Uses the configured panel_* fields + panel_channel. Default false — only changes settings.",
        },
      },
    },
  },
  {
    name: "manage_scrim",
    description: "Create or interact with a Scrim Matchmaking Lobby tracking game ELO dynamically.",
    input_schema: {
      type: "object",
      properties: {
        action:    { type: "string", description: "'create' to host a new scrim lobby", enum: ["create"] },
        game:      { type: "string", description: "Name of the game being played (e.g. Valorant, League)" },
        team_size: { type: "number", description: "Number of players per team (Defaults to 5)" }
      },
      required: ["action", "game"],
    },
  },
  // ─── Relationship / Mood Management (owner-only, natural language) ────
  {
    name: "adjust_relationship",
    description:
      "Adjust how you feel about a specific user. Use when the owner tells you to forgive someone, like someone more, dislike someone, reset your feelings, etc. The affinity_delta shifts your internal relationship score (-100 to +100 range). Positive = warmer feelings, negative = colder. Examples: forgive (+20 to +40), like (+15 to +30), love (+40 to +60), dislike (-20 to -40), hate (-40 to -60), reset to neutral (use reset: true).",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID of the person" },
        affinity_delta: { type: "number", description: "How much to shift feelings (-100 to +100). Positive = like more, negative = like less" },
        reset: { type: "boolean", description: "If true, reset relationship to neutral (0) instead of shifting" },
        reason: { type: "string", description: "Brief note about why (e.g. 'owner said to forgive them')" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "adjust_mood",
    description:
      "Adjust your own mood and energy. Use when the owner tells you to cheer up, calm down, take a nap, rest, etc. mood_delta shifts mood score (-100 to +100), energy_delta shifts energy (0 to 100). Napping: energy_delta +35, mood_delta +15. Cheering up: mood_delta +20 to +40.",
    input_schema: {
      type: "object",
      properties: {
        mood_delta: { type: "number", description: "Mood shift (-100 to +100)" },
        energy_delta: { type: "number", description: "Energy shift (-100 to +100)" },
        reason: { type: "string", description: "Why the adjustment" },
      },
    },
  },
];

export const EVERYONE_TOOLS = [
  // ─── Birthday ────────────────────────────────────────────────────────
  {
    name: "set_birthday",
    description: "Save a user's birthday. Use this when someone tells you their birthday, says 'my birthday is ...', 'remember my birthday', etc. Parse the date from natural language (e.g. 'march 15 2001', 'jan 3rd', '12/25/1999'). Include the year if they provide it — this lets us show their age on their birthday. You can also set another user's birthday if they share it.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username whose birthday to set. Omit or leave blank to use the person asking." },
        month:    { type: "number", description: "Month number 1–12" },
        day:      { type: "number", description: "Day of month 1–31" },
        year:     { type: "number", description: "Birth year (e.g. 2001). Optional — only include if the user provides it." },
      },
      required: ["month", "day"],
    },
  },
  {
    name: "get_birthday",
    description: "Look up someone's birthday, current age, what age they're turning, and days until their next birthday. ALWAYS call this tool when asked anything about age, birthday, how old someone is, or when someone's birthday is. NEVER calculate ages yourself — this tool returns the exact pre-calculated answer.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to look up. Omit to check the person asking." },
      },
    },
  },
  {
    name: "list_birthdays",
    description: "List upcoming birthdays in the server, sorted by how soon they are.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_birthday",
    description: "Remove a user's birthday. Use when someone says 'forget my birthday', 'remove my birthday', etc.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username whose birthday to remove. Omit to remove the person asking's." },
      },
    },
  },
  // ─── Music ────────────────────────────────────────────────────────────
  {
    name: "play_music",
    description: "Play a song or playlist in the user's voice channel. Supports YouTube URLs/search, Spotify track/playlist/album URLs, SoundCloud URLs, or plain text search. Use when someone EXPLICITLY asks to play, queue, or put on music (e.g., 'play X', 'queue Y', 'put on Z in vc', 'add this to the queue'). DO NOT call this when someone is just SHARING or SHOWING OFF music — e.g. 'check out my spotify', 'heres my spotify', 'listen to my music', 'this is my stuff', 'im an artist heres my page', sending their own artist link, or dropping a link without a play verb. In those cases they want you to LISTEN/REACT as a person, not start the music bot — just respond conversationally about their music. Also DO NOT call if no one is in a VC and the message isn't clearly a play request.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song name, YouTube URL, Spotify URL, SoundCloud URL, or search text" },
      },
      required: ["query"],
    },
  },
  {
    name: "skip_song",
    description: "Skip the current song. Use when someone says 'skip', 'next', 'next song', etc.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "stop_music",
    description: "Stop playing music and leave the voice channel. Use when someone says 'stop', 'leave', 'disconnect', 'get out', etc.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pause_music",
    description: "Pause the current song.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "resume_music",
    description: "Resume a paused song.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "music_queue",
    description: "Show the current music queue — what's playing and what's up next.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "now_playing",
    description: "Show what song is currently playing.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_volume",
    description: "Set the music volume (0-100).",
    input_schema: {
      type: "object",
      properties: { volume: { type: "number", description: "Volume level 0-100" } },
      required: ["volume"],
    },
  },
  {
    name: "toggle_loop",
    description: "Toggle looping the current song or the entire queue. Use when someone says 'loop', 'repeat', 'loop queue', etc.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["song", "queue", "off"], description: "'song' = loop current track, 'queue' = loop entire queue, 'off' = disable looping" },
      },
      required: ["mode"],
    },
  },
  {
    name: "shuffle_queue",
    description: "Toggle shuffle mode for the music queue.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "music_filter",
    description: "Apply an audio filter/effect to the music. Use when someone asks for bass boost, nightcore, vaporwave, 8D audio, karaoke, etc.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["none", "bassboost", "nightcore", "vaporwave", "8d", "karaoke", "tremolo", "vibrato", "lowpass"], description: "Filter to apply. 'none' removes all filters." },
      },
      required: ["filter"],
    },
  },
  {
    name: "start_lyrics_mode",
    description: "Start LYRICS MODE — displays synced song lyrics in real-time as music plays. Two modes: 'message' (default, safe — edits one message with lyrics) or 'nickname' (changes your server nickname to the lyric line). This is NOT the karaoke audio filter. Use when someone says 'lyrics mode', 'show lyrics', 'display lyrics', 'sing along'. Auto-detects current song if no song/artist given.",
    input_schema: {
      type: "object",
      properties: {
        song:   { type: "string", description: "Song title (leave empty to auto-detect from music player)" },
        artist: { type: "string", description: "Artist name (leave empty to auto-detect)" },
        mode:   { type: "string", enum: ["message", "nickname"], description: "Display mode: 'message' (edits a message, default) or 'nickname' (changes bot nickname)" },
      },
    },
  },
  {
    name: "stop_lyrics_mode",
    description: "Stop lyrics mode and restore your normal nickname. Use when someone says 'stop lyrics', 'turn off lyrics', 'stop the lyrics thing', 'lyrics off'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "auto_lyrics_mode",
    description: "Enable auto lyrics mode — lyrics will automatically show for every track that plays. Use when someone says 'auto lyrics', 'always show lyrics', 'lyrics for every song'.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Test / Preview ─────────────────────────────────────────────────
  {
    name: "test_patch_news",
    description: "Fetch and display a patch note from a game or GPU feed. Can get the latest, a previous one ('the one before that'), or search by version number. Available feeds: valorant, league, fortnite, minecraft, apex, overwatch, csgo, nvidia, amd, gaming.",
    input_schema: {
      type: "object",
      properties: {
        feed: { type: "string", description: "Feed name (valorant, league, nvidia, etc) or a custom RSS URL" },
        offset: { type: "number", description: "0 = latest (default), 1 = one before that, 2 = two before, etc. Use when someone asks for 'the previous one' or 'the one before that'" },
        search: { type: "string", description: "Search for a specific patch by text (e.g. '12.03', 'act 2', 'miks'). Overrides offset." },
      },
      required: ["feed"],
    },
  },
  {
    name: "send_test_birthday",
    description: "Send a test birthday announcement in the current channel to preview what it looks like. Uses the requesting user as the birthday person.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_test_welcome",
    description: "Send a test welcome message in the current channel using the real welcome card design. Use this when someone asks to preview, test, or demo the welcome message. Uses the requesting user as the test member.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_gif",
    description: "Search for a GIF and send it in the channel. Use this for memes, reactions, jokes, internet culture — e.g. 'dab', 'kiss', 'hug', 'slap', '6 9 meme', 'rizz', 'npc', 'sigma', 'trollface', 'rickroll', 'yes chad', etc. Always use this when someone wants a meme reaction or asks you to 'do' something physical/expressive.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms for the GIF (keep it short and specific, e.g. 'dab dance', 'anime kiss', '6 9 meme')" },
        caption: { type: "string", description: "Optional message to send with the GIF (e.g. mentioning the target user)" },
      },
      required: ["query"],
    },
  },
  {
    name: "set_gif_style",
    description: "Toggle how GIFs are displayed in this server. 'raw' = just the GIF, no embed border (clean look). 'embed' = GIF inside a colored embed (default). Use when someone asks to remove the GIF border, make GIFs clean/raw, or bring back the embed style.",
    input_schema: {
      type: "object",
      properties: {
        style: { type: "string", enum: ["raw", "embed"], description: "'raw' = no border, just the GIF. 'embed' = colored embed border (default)" },
      },
      required: ["style"],
    },
  },
  {
    name: "get_server_info",
    description: "Get server stats (members, channels, roles, boosts, etc.)",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_dm_preference",
    description: "Set whether Irene should DM a user. Use this when someone says they don't want DMs ('don't DM me', 'stop sending me DMs', 'no more DMs') or wants to re-enable them ('you can DM me again'). Can set for yourself or, if admin, for another user.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to update (leave blank to apply to the person asking)" },
        allow_dms: { type: "boolean", description: "true = allow DMs, false = no DMs" },
      },
      required: ["allow_dms"],
    },
  },
  {
    name: "get_user_info",
    description: "Get info about a user (join date, roles, etc.)",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to look up" } },
      required: ["username"],
    },
  },
  {
    name: "list_channels",
    description: "List all channels organized by category",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_roles",
    description: "List all roles with member counts",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_role_permissions",
    description: "Read the current permissions assigned to a role. Use this to check what a role can and can't do before making changes.",
    input_schema: {
      type: "object",
      properties: { role_name: { type: "string", description: "Name of the role to inspect" } },
      required: ["role_name"],
    },
  },
  {
    name: "list_emojis",
    description: "List all custom emojis in the server",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_bans",
    description: "List banned users",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "random_member",
    description: "Pick a random member from the server (for giveaways, picking someone, etc.)",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Only pick from members with this role (optional)" },
        count: { type: "number", description: "How many random members to pick (default: 1)" },
      },
    },
  },
  {
    name: "count_members",
    description: "Count members, optionally filtered by role or status",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Count members with this role (optional)" },
        status: { type: "string", enum: ["online", "idle", "dnd", "offline"], description: "Filter by status (optional)" },
      },
    },
  },
  {
    name: "who_has_role",
    description: "List all members who have a specific role",
    input_schema: {
      type: "object",
      properties: { role_name: { type: "string", description: "Role name" } },
      required: ["role_name"],
    },
  },
  // ─── Temp VC Controls (for channel owners) ─────────────────────────
  {
    name: "vc_info",
    description: "Show info about the voice channel you're currently in — members, what they're playing, owner, limit, bitrate",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_private",
    description: "Make your temp voice channel private — blocks new people from joining. Current members can still rejoin. Use vc_allow to let specific people in.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_public",
    description: "Make your private temp VC public again so anyone can join",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_lock",
    description: "Lock your VC's user limit. If no limit given, locks to the current member count.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max users (omit = lock to current member count)" },
      },
    },
  },
  {
    name: "vc_unlock",
    description: "Remove the user limit from your temp VC so anyone can join",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vc_rename",
    description: "Rename your temp voice channel",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "New channel name" } },
      required: ["name"],
    },
  },
  {
    name: "vc_transfer",
    description: "Give ownership of your temp VC to someone else in the channel",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to transfer ownership to" } },
      required: ["username"],
    },
  },
  {
    name: "vc_kick",
    description: "Kick someone out of your temp voice channel. Optionally ban them from rejoining.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to kick" },
        ban: { type: "boolean", description: "Prevent them from rejoining (default: false)" },
      },
      required: ["username"],
    },
  },
  {
    name: "vc_allow",
    description: "Allow a specific user to join your private temp VC",
    input_schema: {
      type: "object",
      properties: { username: { type: "string", description: "Username to allow" } },
      required: ["username"],
    },
  },
  {
    name: "vc_claim",
    description: "Claim ownership of a temp VC whose owner already left. You must be in the channel.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Reminder Tools ────────────────────────────────────────────────────
  {
    name: "reminder_set",
    description: "Set a reminder for the user. They'll be pinged in this channel at the specified time with their reminder message.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to remind them about" },
        delay_minutes: { type: "number", description: "How many minutes from now to fire the reminder" },
      },
      required: ["message", "delay_minutes"],
    },
  },
  {
    name: "reminder_cancel",
    description: "Cancel a previously set reminder by ID",
    input_schema: {
      type: "object",
      properties: {
        reminder_id: { type: "number", description: "ID of the reminder to cancel (from the confirmation message)" },
      },
      required: ["reminder_id"],
    },
  },
  // ─── Deferred Task Scheduling ──────────────────────────────────────────
  {
    name: "schedule_task",
    description: "Schedule ANY other tool call to run after a delay. Use this for compound, time-separated requests — e.g. 'timeout X for 5m but remove it after 10 seconds' → call timeout_user NOW, then schedule_task with tool_name 'untimeout_user' and delay_seconds 10. NEVER call a mod action and its reversal in the same turn (they race — the reversal will fire before the action lands). Works with any tool: untimeout_user, unban_user, unmute_user, send_message, remove_role, etc. You can chain multiple scheduled tasks to build complex timelines.",
    input_schema: {
      type: "object",
      properties: {
        delay_seconds: { type: "number", description: "Seconds from now to fire. Min 3, max 604800 (7 days)." },
        tool_name: { type: "string", description: "Name of the tool to invoke when the timer fires (e.g. 'untimeout_user')" },
        tool_input: { type: "object", description: "Arguments object for the scheduled tool — identical shape to calling it directly" },
        note: { type: "string", description: "Optional short note about why this task is scheduled — shown in list_scheduled_tasks" },
      },
      required: ["delay_seconds", "tool_name", "tool_input"],
    },
  },
  {
    name: "cancel_scheduled_task",
    description: "Cancel a pending scheduled task by its ID before it fires.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number", description: "ID returned by schedule_task or shown in list_scheduled_tasks" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_scheduled_tasks",
    description: "List pending scheduled tasks for this server with their IDs, tool names, fire times, and notes. Use this before cancelling to find the right ID.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── Eris (Twin Sister) Integration ────────────────────────────
  {
    name: "ask_eris",
    description: "Contact your twin sister Eris to do something for you. She handles reminders, notes, price tracking, news tracking, and other personal assistant tasks. Use this when someone asks for a reminder, to save a note, track a price, or anything Eris specializes in. Talk about her naturally — she's your sister, you two are close. You can say things like 'let me ask my sister to handle that' or 'eris's got that covered'.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "What to ask Eris to do: 'remind', 'note', 'fact', 'mood', 'status'" },
        user_id: { type: "string", description: "Discord user ID this is for" },
        channel_id: { type: "string", description: "Channel ID for context" },
        reminder_text: { type: "string", description: "For reminders: what to remind about" },
        delay_minutes: { type: "number", description: "For reminders: minutes from now" },
        title: { type: "string", description: "For notes: note title" },
        content: { type: "string", description: "For notes: note content" },
        fact: { type: "string", description: "For facts: the fact to remember" },
      },
      required: ["action"],
    },
  },
  // ─── Calculator ──────────────────────────────────────────────────────
  {
    name: "calculate",
    description: "Evaluate a math expression and return the exact result. Use this for ANY math — arithmetic, algebra, percentages, unit conversions, etc. ALWAYS use this tool instead of doing math in your head. Supports: +, -, *, /, ** (power), % (modulo), sqrt(), abs(), sin(), cos(), tan(), log(), log2(), log10(), ceil(), floor(), round(), min(), max(), PI, E. You can chain expressions separated by semicolons — the last value is returned. You can also assign variables: a = 5; b = 10; a * b",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "The math expression to evaluate. Examples: '2 + 2', '(15 * 3) / 7', 'sqrt(144)', '2 ** 10', 'a = 25; b = 4; a * b', '((2026 - 2004) * 365.25)'" },
        show_steps: { type: "boolean", description: "If true, break down the calculation step by step in the result so you can explain it to the user" },
      },
      required: ["expression"],
    },
  },
  // ─── Web Search & Read ───────────────────────────────────────────────
  {
    name: "web_search",
    description: "Search the internet and return top results with titles, URLs, and snippets. Use for current events, fact-checking, looking up formulas, definitions, prices, stats, news, or anything that needs up-to-date information. ALWAYS use this when you're unsure about a fact or the user asks about something current.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_read",
    description: "Fetch and read the text content of a web page URL. Use after web_search to get detailed info from a specific result, or when a user shares a link and asks about it.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to fetch" },
      },
      required: ["url"],
    },
  },
  // ─── Snipe ──────────────────────────────────────────────────────────
  {
    name: "snipe",
    description: "Show a deleted message in this channel. Stores up to 10 deleted messages per channel for 30 minutes. Use index to go further back (1=most recent, 2=second, etc). Use when someone says 'snipe', 'what was deleted', 'what did they say'.",
    input_schema: { type: "object", properties: { index: { type: "integer", description: "Which deleted message to show (1=most recent, 2=second most recent, etc). Default: 1" } } },
  },
  {
    name: "editsnipe",
    description: "Show what a message said BEFORE it was edited. Stores up to 10 edits per channel for 30 minutes. Use when someone says 'editsnipe', 'what did they edit', 'what was the original message', 'what did it say before'.",
    input_schema: { type: "object", properties: { index: { type: "integer", description: "Which edit to show (1=most recent, 2=second, etc). Default: 1" } } },
  },
  {
    name: "save_directive",
    description: "Save a behavioral rule/instruction that you will follow persistently. Use when an admin tells you to do (or not do) something as a standing rule. Examples: 'don't reply in #announcements', 'always speak spanish in #español', 'be extra sarcastic in #shitposting'. IMPORTANT: When a user gives you a standing instruction (not a one-time request), ALWAYS save it as a directive so you remember it forever.",
    input_schema: {
      type: "object",
      properties: {
        directive: { type: "string", description: "The rule to follow, in clear language (max 300 chars)" },
        channel_name: { type: "string", description: "If this rule only applies to a specific channel, name it here. Leave empty for server-wide rules" },
      },
      required: ["directive"],
    },
  },
  {
    name: "list_directives",
    description: "List all saved behavioral directives/rules for this server. Use when someone asks 'what are your rules' or 'what directives do you have'",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_directive",
    description: "Remove a saved directive by keyword or index number. Use when an admin says to forget a rule or stop following an instruction.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search for in the directive text, OR the index number" },
      },
      required: ["keyword"],
    },
  },
  ...NEW_EVERYONE_TOOLS,
];

// ─── Register tools with the two-tier registry ───
import { registerPresenceBotTools } from "./toolRegistry.js";
registerPresenceBotTools(ADMIN_TOOLS, EVERYONE_TOOLS);
