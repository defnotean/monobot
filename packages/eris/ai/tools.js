// ─── packages/eris/ai/tools.js ──────────────────────────────────────────
// Public facade ("barrel") for every AI tool schema (EVERYONE_TOOLS + OWNER_TOOLS).
// The actual schema declarations now live in sibling modules under ai/tools/*;
// this file re-exports the identical public surface so no importer needs to change.
// Add `tags: ["fun"]` to opt a tool into the twin-conversation profile.
// Handlers live in ai/executor.js / ai/executors/* — these schemas are pure data.
// See docs/ai-pipeline-eris.md §3 (two-tier tool selection) and §5.
//
// ─── MODULE MAP ──────────────────────────────────────────────────────────────
//   EVERYONE_TOOLS (ai/tools/everyoneTools.js) concatenates:
//     tools/everyone/memoryDirectives.js — memory, directives, self-knowledge
//     tools/everyone/mediaWeb.js .......... media, web, memes, presence, takes
//     tools/everyone/notesReminders.js .... notes, reminders, code helpers
//     tools/everyone/moodConfig.js ........ mood, game tracking, channel config
//     tools/everyone/economyGames.js ...... economy core, gambling, mini-games
//     tools/everyone/combatPets.js ........ combat, pets, territories, features
//     tools/everyone/incomeBanking.js ..... income, banking, rewards, marriage
//   OWNER_TOOLS (ai/tools/ownerTools.js) concatenates:
//     tools/owner/systemPersonality.js .... system access, terminal, rigging
//     tools/owner/opsTools.js ............. email, github, deploy, database, host
//     tools/owner/whitelistPersona.js ..... whitelist, trust, persona, ask_irene
//     tools/owner/relationshipMood.js ..... relationship & mood (appended last)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A single AI tool declaration (Anthropic schema format). `input_schema` and
 * `tags` vary per tool, so they're typed loosely — this is pure declaration
 * data consumed by the provider formatters and the tool registry.
 * @typedef {{ name: string, description: string, input_schema?: any, tags?: string[] }} ToolDef
 */

import { EVERYONE_TOOLS } from "./tools/everyoneTools.js";
import { OWNER_TOOLS } from "./tools/ownerTools.js";

export { EVERYONE_TOOLS, OWNER_TOOLS };

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED EXPORT + TOOL-REGISTRY WIRING
// ALL_TOOLS = EVERYONE_TOOLS + OWNER_TOOLS, then we hand the two tiers to the
// permission-aware registry so each tool dispatches with the correct gate.
// ═══════════════════════════════════════════════════════════════════════════

// Hide PC-agent tools entirely from the model when PC_AGENT_DISABLED=1, so it
// can't call them in the first place. Without this they're still exposed and
// just return a "disabled" string, which confuses weaker models.
// Direct env-var read (avoid importing config so test-loaders that don't run
// the .env validator stay happy). We mutate the OWNER_TOOLS array in place so
// every importer (which shares this same array reference) sees the removal.
if (process.env.PC_AGENT_DISABLED === "1") {
  const _PC_AGENT_TOOLS = new Set(["execute_terminal", "execute_local", "system_info", "list_processes", "launch_app", "browse_files"]);
  for (let i = OWNER_TOOLS.length - 1; i >= 0; i--) {
    if (_PC_AGENT_TOOLS.has(OWNER_TOOLS[i].name)) OWNER_TOOLS.splice(i, 1);
  }
}

export const ALL_TOOLS = [...EVERYONE_TOOLS, ...OWNER_TOOLS];

// ─── Register tools with the two-tier registry ───
import { registerOpenClawTools } from "./toolRegistry.js";
registerOpenClawTools(EVERYONE_TOOLS, OWNER_TOOLS);
