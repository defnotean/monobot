// @ts-check
// ─── packages/eris/ai/tools/owner/whitelistPersona.js ────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// OWNER TOOLS — WHITELIST, TRUST, PERSONA & TWIN DELEGATION
// Cross-twin server whitelist management, granting/revoking trusted-user
// status, customizing Eris's avatar/banner/name/nickname (and per-server
// persona), and ask_irene — delegate any server moderation to her sister.
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const WHITELIST_PERSONA_TOOLS = [
  {
    name: "whitelist_server",
    description: "Add a Discord server to the shared whitelist so both Irene and Eris can stay in it. Owner only. Accepts either a guild ID OR a discord invite link (discord.gg/xxx).",
    input_schema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The server/guild ID OR a Discord invite link (discord.gg/xxx or https://discord.gg/xxx)" },
        name: { type: "string", description: "Server name for reference" },
      },
      required: ["guild_id"],
    },
  },
  {
    name: "unwhitelist_server",
    description: "Remove a server from the shared whitelist. Both bots will leave it. Owner only.",
    input_schema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The server/guild ID to remove" },
      },
      required: ["guild_id"],
    },
  },
  {
    name: "list_whitelist",
    description: "Show all whitelisted servers that both Irene and Eris are allowed to be in. Owner only.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "trust_user",
    description: "Grant a user trusted status so they can customize Eris (change personality, avatar, name, etc). Creator only. Use when the bot owner says 'trust this person' or 'let them customize you'.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to trust" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "untrust_user",
    description: "Remove a user's trusted status. Creator only.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to untrust" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "list_trusted",
    description: "List all trusted users. Creator only.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "change_avatar",
    description: "Change Eris's profile picture/avatar. Only trusted users (creator) can do this. Accepts an image URL.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "URL of the new avatar image" },
      },
      required: ["image_url"],
    },
  },
  {
    name: "change_banner",
    description: "Change Eris's banner. Only trusted users (creator) can do this. Accepts an image URL.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "URL of the new banner image" },
      },
      required: ["image_url"],
    },
  },
  {
    name: "change_name",
    description: "Change Eris's display name/username. Only trusted users (creator) can do this.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The new display name" },
      },
      required: ["name"],
    },
  },
  {
    name: "change_nickname",
    description: "Change Eris's nickname in the current server. Also updates her per-server identity so she goes by the new name in all conversations, history labels, and twin interactions. Only trusted users (creator) can do this.",
    input_schema: {
      type: "object",
      properties: {
        nickname: { type: "string", description: "The new server nickname" },
      },
      required: ["nickname"],
    },
  },
  {
    name: "set_server_persona",
    description: "Change Eris's name AND/OR personality for this server only. Other servers keep her default identity. Use when the creator says 'call yourself X here', 'be more Y in this server', or 'change your personality'. Use reset=true to go back to default.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New name for this server (e.g. 'Luna', 'Nyx', 'Shadow')" },
        personality: { type: "string", description: "Custom personality instructions for this server (optional, keeps default if not set)" },
        reset: { type: "boolean", description: "Set to true to reset name and personality to default Eris" },
      },
    },
  },
  {
    name: "ask_irene",
    description: "Delegate ANY server-management action to your twin sister Irene via the twin API. Permission checks happen inside the tool — DO NOT refuse to try, just call it. Supported commands: purge (delete messages), lock/unlock (channel), slowmode, nickname (set someone's nick), announce (post a message), create_channel (new text/voice channel), set_log_channel, set_welcome_channel, create_role, give_role, remove_role, set_topic, ban, kick, warn, timeout. Use whenever someone says 'tell irene to X', 'ask your sister to X', 'have irene X', or any server-management ask that isn't your own job.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [
            "purge", "lock", "unlock", "slowmode", "nickname", "announce",
            "create_channel", "set_log_channel", "set_welcome_channel",
            "create_role", "give_role", "remove_role", "set_topic",
            "ban", "kick", "warn", "timeout",
          ],
          description: "Which command Irene should run",
        },
        count: { type: "number", description: "For purge: number of messages (1-100)" },
        seconds: { type: "number", description: "For slowmode: seconds (0 to disable)" },
        target_username: { type: "string", description: "For nickname/give_role/remove_role/ban/kick/warn/timeout: who to act on (username, mention, or ID)" },
        nickname: { type: "string", description: "For nickname: new nick (omit to reset)" },
        announcement: { type: "string", description: "For announce: the message to post" },
        channel_name: { type: "string", description: "For create_channel: the channel's name" },
        channel_id: { type: "string", description: "For set_log_channel/set_welcome_channel: the channel ID (defaults to current channel)" },
        category: { type: "string", description: "For create_channel: optional category name" },
        type: { type: "string", enum: ["text", "voice"], description: "For create_channel: 'text' or 'voice' (default text)" },
        private: { type: "boolean", description: "For create_channel: whether the channel should be private" },
        role_name: { type: "string", description: "For create_role/give_role/remove_role: the role's name" },
        color: { type: "string", description: "For create_role: hex color or color name" },
        topic: { type: "string", description: "For set_topic: the channel topic text" },
        reason: { type: "string", description: "For ban/kick/warn/timeout: reason for the action" },
        duration: { type: "string", description: "For timeout: how long (e.g. '5m', '1h', '1d')" },
      },
      required: ["command"],
    },
  },
];
