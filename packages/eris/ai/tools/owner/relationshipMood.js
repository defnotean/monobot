// @ts-check
// ─── packages/eris/ai/tools/owner/relationshipMood.js ────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.
// NOTE: in the original file these two tools were appended to OWNER_TOOLS via
// `.push(...)` AFTER the main array literal, so they sort LAST in OWNER_TOOLS.
// The barrel preserves that ordering by concatenating this group last.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// OWNER TOOLS — RELATIONSHIP & MOOD OVERRIDE (appended via .push)
// Natural-language-driven owner controls for nudging Eris's internal affinity
// scores per user, and tweaking her mood/energy levels (e.g. "cheer up", "nap").
// ═══════════════════════════════════════════════════════════════════════════
// ─── Relationship / Mood Management (owner-only, natural language driven) ────
/** @type {ToolDef[]} */
export const RELATIONSHIP_MOOD_TOOLS = [
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
