// @ts-check
// ─── packages/eris/ai/tools/everyone/combatPets.js ───────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — COMBAT, PETS, TERRITORIES & SOCIAL CHAOS
// Group activities: heists (3+ participants), boss battles (server-wide HP),
// territory claims (passive income per channel), pet adoption / care, and
// social chaos (roast battles, hot takes) plus per-server feature toggles.
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const COMBAT_PET_TOOLS = [
  // ─── Heists ──────────────────────────────────────────────────────────

  {
    name: "heist_start",
    description: "Organize a heist targeting the richest user. Need 3+ participants. Use when someone says 'heist', 'organize a heist', 'lets rob someone together'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "heist_join",
    description: "Join an active heist in recruiting phase. Use when someone says 'join heist', 'im in', 'count me in for the heist'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "heist_execute",
    description: "Execute the heist once enough people have joined (3+). Use when someone says 'execute heist', 'go', 'do the heist', 'lets go'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Boss Battles ────────────────────────────────────────────────────

  {
    name: "boss_spawn",
    description: "Spawn a server-wide boss battle. Everyone can contribute damage. Use when someone says 'spawn boss', 'boss battle', 'boss fight', 'summon a boss'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "boss_attack",
    description: "Attack the active boss. Costs 10 coins per attack. Use when someone says 'attack boss', 'hit the boss', 'fight boss'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "boss_status",
    description: "Check the current boss battle status (HP, phase, participants). Use when someone asks 'boss status', 'how much hp left', 'boss health'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Territories ─────────────────────────────────────────────────────

  {
    name: "territory_claim",
    description: "Claim this channel as your territory for passive coin income. Costs 500 coins. Use when someone says 'claim this channel', 'claim territory', 'this is mine'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "territory_map",
    description: "View all claimed territories in the server. Use when someone says 'territory map', 'who owns what', 'territories'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "territory_collect",
    description: "Collect passive income from your territory. Use when someone says 'collect income', 'collect territory', 'get my money'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Pets ────────────────────────────────────────────────────────────

  {
    name: "pet_adopt",
    description: "Adopt a random pet for 200 coins. Each pet has unique bonuses. Use when someone says 'adopt pet', 'get a pet', 'I want a pet'.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Name for your new pet" } }, required: ["name"] },
  },
  {
    name: "pet_feed",
    description: "Feed your pet to restore hunger and mood. Costs 25 coins. Use when someone says 'feed pet', 'feed my pet'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pet_status",
    description: "Check your pet's stats, hunger, mood, and level. Use when someone says 'pet status', 'how is my pet', 'pet info', 'my pet'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pet_rename",
    description: "Rename your pet. Use when someone says 'rename pet', 'change pet name'.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "New name for the pet" } }, required: ["name"] },
  },

  // ─── Social Chaos ────────────────────────────────────────────────────

  {
    name: "roast_challenge",
    description: "Challenge someone to a roast battle. Eris roasts both players, chat votes who got cooked harder. Use when someone says 'roast battle', 'roast X', '1v1 roast'.",
    input_schema: { type: "object", properties: { target: { type: "string", description: "Username to challenge" } }, required: ["target"] },
  },
  {
    name: "hot_take",
    description: "Generate a spicy hot take. Use when someone says 'hot take', 'give me a take', 'controversial opinion', 'unpopular opinion'.",
    input_schema: { type: "object", properties: {} },
  },

  // ─── Feature Configuration ───────────────────────────────────────────

  {
    name: "configure_feature",
    description: "Configure server-level features: enable/disable features, set feature notification channels, and set feature ping roles. Use when someone says 'set gambling channel', 'disable economy', 'set ping role for events', 'configure boss battles', or 'turn off stocks'. Do not use this for game odds/payout tuning; use configure_game. Do not use this for slot symbols; use configure_slots. Available features: economy, gambling, events, confessions, boss_battles, stocks, heists, territories, pets, daily_challenges, achievements, loans.",
    input_schema: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature to configure: economy, gambling, events, confessions, boss_battles, stocks, heists, territories, pets, daily_challenges, achievements, loans" },
        enabled: { type: "boolean", description: "Enable or disable this feature for this server" },
        channel: { type: "string", description: "Channel name to send notifications/announcements for this feature" },
        ping_roles: { type: "string", description: "Role(s) to ping for this feature's announcements. Comma-separated for multiple." },
      },
      required: ["feature"],
    },
  },
  {
    name: "list_features",
    description: "List all feature configurations for this server — shows which features are enabled, their channels, and ping roles. Use when someone says 'list features', 'show settings', 'what's configured', 'feature status'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "toggle_twin_chat",
    description: "Enable or disable twin sister chat (Eris and Irene talking to each other) in this server. Use when someone says 'disable twin chat', 'stop the twins talking', 'enable twin chat', 'let them talk again'.",
    input_schema: { type: "object", properties: { enabled: { type: "boolean", description: "true to enable, false to disable" } }, required: ["enabled"] },
  },
  {
    name: "configure_bump_reminder",
    description: "Configure which roles get pinged 2 hours after a DISBOARD bump, so the server knows it's time to bump again. Use when someone asks you to set up the bump reminder, add/remove roles from it, or check what's configured. Requires Manage Server permission. Actions: 'add' (add role_ids to ping list), 'remove' (remove role_ids), 'list' (show current roles), 'clear' (remove all roles). Extract role IDs from @role mentions in the message — they appear as <@&ROLEID> in Discord.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "list", "clear"],
          description: "What to do: 'add', 'remove', 'list', or 'clear'",
        },
        role_ids: {
          type: "array",
          items: { type: "string" },
          description: "Discord role IDs to add or remove (extract from <@&ROLEID> mentions). Leave empty for 'list' and 'clear'.",
        },
      },
      required: ["action"],
    },
  },
];
