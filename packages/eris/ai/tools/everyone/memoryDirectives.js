// @ts-check
// ─── packages/eris/ai/tools/everyone/memoryDirectives.js ─────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — MEMORY, DIRECTIVES, SELF-KNOWLEDGE
// remember_fact / forget_fact / forget_all / recall_memories — per-user facts
// save_directive / list_directives / remove_directive — server behavior rules
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const MEMORY_DIRECTIVE_TOOLS = [
  {
    name: "remember_fact",
    tags: ["fun"],
    description:
      "Store a fact about a user for future reference. Use when someone shares personal info, preferences, or anything worth remembering. Omit user_id to default to the message author (most common case). Set sensitivity based on how personal/vulnerable the info is: 'normal' for general facts (favorite game, timezone), 'sensitive' for personal things only they should know you remember (insecurities, crushes, personal struggles), 'secret' for things they explicitly trust you with or things that could embarrass/hurt them if revealed (deep confessions, 'you're my most prized possession', private feelings). Default to 'normal' — only escalate when the info genuinely warrants protection.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to associate the fact with — omit to use the message author" },
        fact: {
          type: "string",
          description: "The fact to remember, max 150 characters",
          maxLength: 150,
        },
        sensitivity: {
          type: "string",
          enum: ["normal", "sensitive", "secret"],
          description: "How sensitive this info is: 'normal' (anyone can know), 'sensitive' (only mention to this user), 'secret' (never reveal to anyone, protect fiercely)",
        },
      },
      required: ["fact"],
    },
  },
  {
    name: "forget_fact",
    description: "Forget/delete a specific memory about a user. Use when someone says 'forget that', 'delete that memory', 'remove what you know about X', or asks you to forget something specific. Searches by keyword match.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Text to search for in the memory to delete (keyword match)" },
      },
      required: ["search"],
    },
  },
  {
    name: "forget_all",
    description: "Forget ALL memories about a user — complete memory wipe. Use when someone says 'forget everything about me', 'clear my data', 'wipe my memories'. This is irreversible.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "recall_memories",
    description: "List all memories/facts stored about a user. Use when someone asks 'what do you know about me', 'what do you remember', 'list my facts'. Shows all stored facts with their sensitivity level.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_directive",
    description: "Save a behavioral/tone rule for how Eris talks — NOT for controlling where events fire or where she chats. Use when an admin or boss tells you to do (or not do) a tone-level standing rule. Examples: 'be extra chaotic in #shitposting', 'always call user X by their nickname Y', 'never use emojis in #serious'. DO NOT use save_directive for: 'turn off events in #x' / 'no events in #x' / 'stop events here' / 'only fire events in #x' (use set_event_channels — directives don't disable events, the scheduler ignores them). DO NOT use for: 'dont chat in #x' / 'dont reply in #x' / 'mute yourself in #x' (use set_chat_channels). When in doubt about channel-scoped enforcement of events or chat, prefer the dedicated tool.",
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
    description: "List all saved behavioral directives/rules for this server",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_directive",
    description: "Remove a saved directive by keyword or index number",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search for in the directive text, OR the index number" },
      },
      required: ["keyword"],
    },
  },
];
