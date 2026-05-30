// @ts-check
// ─── packages/eris/ai/tools/ownerTools.js ────────────────────────────────
// Aggregator for the OWNER-tier tool schemas. Concatenates the category
// groups (in their original file order) into a single OWNER_TOOLS array.
// RELATIONSHIP_MOOD_TOOLS go LAST to mirror the original `.push(...)` append.
// Pure data — handlers live in ai/executor.js / ai/executors/*.

import { SYSTEM_PERSONALITY_TOOLS } from "./owner/systemPersonality.js";
import { OPS_TOOLS } from "./owner/opsTools.js";
import { WHITELIST_PERSONA_TOOLS } from "./owner/whitelistPersona.js";
import { RELATIONSHIP_MOOD_TOOLS } from "./owner/relationshipMood.js";

/**
 * @typedef {import("../tools.js").ToolDef} ToolDef
 */

/** @type {ToolDef[]} */
export const OWNER_TOOLS = [
  ...SYSTEM_PERSONALITY_TOOLS,
  ...OPS_TOOLS,
  ...WHITELIST_PERSONA_TOOLS,
  // ─── Relationship / Mood (originally appended via OWNER_TOOLS.push) ────
  ...RELATIONSHIP_MOOD_TOOLS,
];
