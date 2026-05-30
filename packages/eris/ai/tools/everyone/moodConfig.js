// @ts-check
// ─── packages/eris/ai/tools/everyone/moodConfig.js ───────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — MOOD, GAME TRACKING, CHANNEL CONFIG, PRICES
// get_mood / get_relationship — introspection
// track_game / untrack_game / list_game_watches — Steam patch-note watcher
// set_event_channels / set_chat_channels / test_fire_event — server config
// watch_price / check_prices / unwatch_price — product price monitoring
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const MOOD_CONFIG_TOOLS = [
  // ─── REFERENCE TOOL ─── This is a canonical example. New contributors: copy this pattern when adding a tool. See packages/eris/ai/executors/miscExecutor.js:63 for the matching handler and packages/eris/tests/ai/getMoodTool.test.ts:1 for the spec. ───
  {
    name: "get_mood",
    tags: ["fun"],
    description:
      "Check Irene's current mood/attitude level. Use for introspection when someone asks how you're feeling or to calibrate your sass level.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_relationship",
    tags: ["fun"],
    description:
      "Check the relationship status and history with a specific user or the server in general. Use to recall how you feel about someone or review past interactions.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID to check relationship with; omit for general server vibe" },
      },
      required: [],
    },
  },
  {
    name: "track_game",
    description:
      "Start auto-tracking patch notes and update announcements for a game. Searches Steam for the game, then posts new updates automatically to this channel every time one drops. Use when someone says 'track updates for X', 'watch for X patches', 'notify me when X gets updated'. Requires Manage Server permission.",
    input_schema: {
      type: "object",
      properties: {
        game_name: { type: "string", description: "Name of the game to track on Steam" },
        rss_url:   { type: "string", description: "Optional: custom RSS feed URL for non-Steam games" },
      },
      required: ["game_name"],
    },
  },
  {
    name: "untrack_game",
    description:
      "Stop tracking game updates. Call this directly when the user names a game ('stop tracking marvel rivals', 'unwatch valorant'); the executor accepts a game name as well as a watch ID. Do NOT call list_game_watches first unless the user asks to see them.",
    input_schema: {
      type: "object",
      properties: {
        watch_id: { type: "string", description: "The watch ID to remove (from list_game_watches)" },
        game: { type: "string", description: "Game name to unwatch — used when the user named a game directly without listing first" },
      },
    },
  },
  {
    name: "list_game_watches",
    description:
      "Show all active game update watches for this server. Use when someone asks 'what games are being tracked', 'show game watches', 'list tracked games'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_event_channels",
    description: "ALWAYS use this for any ask about where server events (coin rain, chaos storm, lucky hour, pirate raid, etc.) fire — these phrasings ALL map here: 'turn off events in #x', 'no events in #x', 'stop events in #x', 'disable events here', 'block events from #x', 'only fire events in #x', 'restrict events to #x'. Action mapping: 'turn off / no / stop / disable / block events in <channels>' → action='deny' with those channels. 'only fire in / restrict to <channels>' → action='set'. 'where do events fire' → action='list'. 'enable events everywhere again' → action='clear' (whitelist) or 'clear_denied' (denylist). Affects random/event automation only — Eris's chat replies are controlled by set_chat_channels. The event scheduler reads ONLY from this tool's settings — save_directive does NOT disable events, only this tool does.",
    input_schema: {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channel names or IDs (e.g. ['eris-shenanigans', 'bot-commands']). Optional for 'list', 'clear', and 'clear_denied'.",
        },
        action: { type: "string", enum: ["set", "add", "remove", "clear", "list", "deny", "undeny", "clear_denied"], description: "Whitelist: 'set' replaces, 'add'/'remove' modify, 'clear' removes the whitelist. Denylist: 'deny' adds channels to the block list, 'undeny' removes them, 'clear_denied' wipes the denylist. 'list' shows both lists." },
      },
    },
  },
  {
    name: "set_chat_channels",
    description: "Manage which channels Eris stays quiet in for normal chat/name-trigger replies. This does not control random server events; use set_event_channels for event firing. Use action:'list' to answer 'where are you muted?', 'what channels don't you talk in?', or 'show me the chat config'. Use 'mute'/'unmute'/'clear' when someone says 'don't chat in #X', 'stop responding in these channels', or 'you can talk here again'. Muted channels mean name triggers stay quiet; direct @mentions still get a reply.",
    input_schema: {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channel names or IDs. Optional for 'list' and 'clear'.",
        },
        action: { type: "string", enum: ["list", "mute", "unmute", "set", "clear"], description: "'list' shows muted channels, 'mute'/'unmute' modify the list, 'set' replaces it, 'clear' removes all mutes" },
      },
    },
  },
  {
    name: "test_fire_event",
    description: "Fire a random server event right now for testing. Use when the owner says 'test an event', 'fire an event', 'trigger a random event'. Owner-only.",
    input_schema: {
      type: "object",
      properties: {
        event_name: { type: "string", description: "Specific event to fire (e.g. 'coin_rain', 'lucky_hour'). Leave empty for random." },
      },
    },
  },
  {
    name: "watch_price",
    description:
      "Monitor a product's price at a URL and optionally alert when it drops below a target. Use when someone wants to track a deal, watch for a sale, or get notified about price changes.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the product page to monitor" },
        product_name: { type: "string", description: "Human-readable name for the product being watched" },
        target_price: { type: "number", description: "Alert when the price drops to or below this amount; omit to just track changes" },
      },
      required: ["url", "product_name"],
    },
  },
  {
    name: "check_prices",
    description:
      "Check the current status of all watched product prices. Use when someone wants to see how their tracked prices are doing.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "unwatch_price",
    description:
      "Stop watching a product's price. Pass either watch_id (from check_prices) OR product_name — the executor matches on either. Use when someone says 'stop watching the laptop price', 'cancel my price watch', etc. Do NOT call check_prices first unless the user asks to see them.",
    input_schema: {
      type: "object",
      properties: {
        watch_id: { type: "string", description: "The unique ID of the price watch (from check_prices)" },
        product_name: { type: "string", description: "Product name to match against — used when the user named the product directly without listing first" },
      },
    },
  },
];
