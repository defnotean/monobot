// @ts-check
// ─── packages/eris/ai/tools/everyoneTools.js ─────────────────────────────
// Aggregator for the EVERYONE-tier tool schemas. Concatenates the category
// groups (in their original file order) into a single EVERYONE_TOOLS array.
// Pure data — handlers live in ai/executor.js / ai/executors/*.

import { MEMORY_DIRECTIVE_TOOLS } from "./everyone/memoryDirectives.js";
import { MEDIA_WEB_TOOLS } from "./everyone/mediaWeb.js";
import { NOTES_REMINDER_TOOLS } from "./everyone/notesReminders.js";
import { MOOD_CONFIG_TOOLS } from "./everyone/moodConfig.js";
import { ECONOMY_GAME_TOOLS } from "./everyone/economyGames.js";
import { COMBAT_PET_TOOLS } from "./everyone/combatPets.js";
import { INCOME_BANKING_TOOLS } from "./everyone/incomeBanking.js";

/**
 * @typedef {import("../tools.js").ToolDef} ToolDef
 */

/** @type {ToolDef[]} */
export const EVERYONE_TOOLS = [
  ...MEMORY_DIRECTIVE_TOOLS,
  ...MEDIA_WEB_TOOLS,
  ...NOTES_REMINDER_TOOLS,
  ...MOOD_CONFIG_TOOLS,
  ...ECONOMY_GAME_TOOLS,
  ...COMBAT_PET_TOOLS,
  ...INCOME_BANKING_TOOLS,
];
