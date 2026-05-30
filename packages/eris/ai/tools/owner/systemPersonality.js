// @ts-check
// ─── packages/eris/ai/tools/owner/systemPersonality.js ───────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// OWNER TOOLS — SYSTEM ACCESS, TERMINAL, PERSONALITY & GAME RIGGING
// Owner-only (the bot owner) machine-level tools: shell exec, local exec with
// audit description, live personality update, full game/slot odds rigging,
// minion management.
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const SYSTEM_PERSONALITY_TOOLS = [
  {
    name: "execute_terminal",
    description:
      "Execute a one-off shell command on the host machine and return stdout/stderr. Owner-only. Use when the bot owner asks to run a command, check something on the server, or perform a system task. For a command that needs an audit description, use execute_local instead.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute (e.g. 'ls -la', 'docker ps')" },
      },
      required: ["command"],
    },
  },
  {
    name: "execute_local",
    description:
      "Execute a local system command with an optional description for audit logging. Owner-only. Use this for scripted or automated host tasks where a human-readable audit description matters. For a simple one-off command, execute_terminal is enough.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run locally on the host" },
        description: { type: "string", description: "Optional human-readable description of what this command does, for logging" },
      },
      required: ["command"],
    },
  },
  {
    name: "update_personality",
    description:
      "Update Eris's personality or system prompt instructions on the fly. Owner-only. Use when the bot owner wants to tweak Eris's behavior, tone, rules, or add new personality traits. Do not use this for Irene; use ask_irene only when delegating to Irene.",
    input_schema: {
      type: "object",
      properties: {
        new_instructions: { type: "string", description: "The new or updated personality/system instructions to apply" },
      },
      required: ["new_instructions"],
    },
  },
  {
    name: "configure_game",
    description: "Full control over built-in game odds, payouts, and behavior. Use for tuning coinflip, dice, blackjack, roulette, RPS, trivia, or global game settings. Do not use for server feature enable/disable or notification channels; use configure_feature for that. List all settings with action='list'. Owner-only.",
    input_schema: {
      type: "object",
      properties: {
        game: { type: "string", enum: ["coinflip", "dice", "blackjack", "roulette", "rps", "trivia", "global", "all"], description: "Which game to configure (lowercase)" },
        setting: { type: "string", description: "Setting to change (e.g. baseOdds, payout, deathChance, botBias)" },
        value: { description: "New value for the setting" },
        action: { type: "string", enum: ["list", "set", "reset"], description: "What to do (lowercase)" },
      },
    },
  },
  {
    name: "minion_status",
    description: "Owner-only. Check the bot owner's minions — workers, earnings, available slots. Minions earn coins passively while away.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "minion_collect",
    description: "Owner-only. Collect accumulated earnings from the bot owner's minions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "minion_name",
    description: "Owner-only. Rename one of the bot owner's minions.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "number", description: "Minion slot number (0-indexed)" },
        name: { type: "string", description: "New name for the minion" },
      },
      required: ["slot", "name"],
    },
  },
  {
    name: "configure_slots",
    description: "Full control over the slot machine symbol table only. Use to add/remove slot symbols, tweak symbol weights, or change symbol payout tiers. Do not use for general game odds; use configure_game for those. Owner-only.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "tweak"], description: "What to do (lowercase)" },
        emoji: { type: "string", description: "For add/tweak: the emoji to use" },
        name: { type: "string", description: "Symbol name (for add/remove/tweak)" },
        weight: { type: "number", description: "Probability weight 1-50 (higher = more common)" },
        tier: { type: "string", enum: ["junk", "common", "rare", "legendary", "skull"], description: "Payout tier (lowercase)" },
      },
    },
  },
];
