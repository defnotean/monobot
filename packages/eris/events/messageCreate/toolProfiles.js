// ─── packages/eris/events/messageCreate/toolProfiles.js ─────────────────────
// Per-message two-tier tool-profile picker.
//
// TIER 1 (real function declarations sent to the model): the _alwaysInclude
// core set + tools whose category keyword-matches this message + tools used
// recently in this channel. Computed per-turn by registry.selectByMessage.
//
// TIER 2 (NOT sent as schemas — a compact "name: one-line desc" CATALOG
// appended to the system prompt): every other accessible tool. The executor
// dispatches BY NAME regardless of whether a schema was sent, so the model
// can still call a Tier-2 tool — the catalog is how it learns the tool exists.
//
// INVARIANT: every accessible tool lands in Tier 1 (as a declaration) OR the
// Tier-2 catalog (by name). Nothing vanishes from both. (The twin profile is
// the one intentional exception — sister talk is deliberately restricted to
// fun-tagged tools, matching prior behavior.)

import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";
import { toGeminiTools } from "../../ai/providers/index.js";
import { registry } from "../../ai/toolRegistry.js";

const DEMOTABLE_CORE_TOOLS = Object.freeze({
  ask_irene: /\b(irene|sister|twin|ask\s+her|ask\s+irene)\b/i,

  forget_fact: /\b(forget|delete|remove|erase).{0,40}\b(memory|fact|remember|know|about me)\b|\bforget that\b/i,
  forget_all: /\b(forget|delete|clear|wipe|erase).{0,40}\b(everything|all).{0,40}\b(memory|memories|data|about me)\b/i,

  analyze_image: /\b(image|photo|picture|attachment|attached|screenshot|look at this|what is this|describe this|analy[sz]e)\b/i,
  search_images: /\b(image|photo|picture|pic|visual|reference).{0,50}\b(search|find|look up|get)\b|\b(search|find|look up|get).{0,50}\b(image|photo|picture|pic|visual|reference)\b/i,
  show_image: /\b(show|post|send|find|get).{0,50}\b(image|photo|picture|pic|what .* looks like|looks like)\b|\bwhat does .{1,50} look like\b/i,
  send_file: /\b(file|attachment|download|attach|script|code|full content|save as|\.txt|\.md|\.json|\.js|\.ts|\.py)\b/i,
  generate_image: /\b(draw|generate|create|make).{0,50}\b(image|picture|photo|art|illustration)\b|\b(image|picture|art) generator\b/i,
  edit_image: /\b(edit|alter|change|modify|remove background|add .{1,30} to).{0,50}\b(image|photo|picture|attachment|attached|this)\b/i,
  search_meme_templates: /\b(meme|template|format|drake|distracted boyfriend|change my mind|stonks|gru|fry)\b/i,
  create_meme: /\b(meme|template|format|drake|distracted boyfriend|change my mind|stonks|gru|fry)\b/i,

  save_note: /\b(note|notes|jot|bookmark|save this|write this down)\b/i,
  list_notes: /\b(list|show|see|browse).{0,40}\bnotes?\b|\bwhat notes?\b/i,
  delete_note: /\b(delete|remove|erase).{0,40}\bnotes?\b/i,
  search_notes: /\b(search|find|look through).{0,40}\bnotes?\b|\bnotes?.{0,40}\b(search|find)\b/i,

  set_reminder: /\b(remind me|reminder|timer|ping me|notify me|in \d+\s*(m|h|d|minutes?|hours?|days?))\b/i,
  list_reminders: /\b(list|show|see).{0,40}\breminders?\b|\bwhat reminders?\b/i,
  cancel_reminder: /\b(cancel|delete|remove|stop).{0,40}\breminders?\b/i,

  configure_feature: /\b(configure|enable|disable|turn on|turn off|set).{0,60}\b(feature|economy|gambling|events|confessions|boss|stocks|heists?|territor|pets?|loans?|channel|ping role)\b/i,
  list_features: /\b(list|show|feature status|settings|configured|configuration).{0,40}\b(features?|settings|configurations?)\b/i,
  toggle_twin_chat: /\b(twin chat|twins? talking|irene).{0,50}\b(enable|disable|turn on|turn off|stop|start|toggle)\b|\b(enable|disable|turn on|turn off|stop|start|toggle).{0,50}\b(twin chat|twins? talking|irene)\b/i,
});

function appendCatalogLines(catalog, tools) {
  if (!tools.length) return catalog;
  const existing = new Set();
  for (const line of String(catalog || "").split("\n")) {
    const match = line.match(/^- [^:]+:\s*(.*)$/i);
    if (!match) continue;
    for (const name of match[1].split(/,\s*/)) {
      if (/^[a-z0-9_]+$/i.test(name)) existing.add(name);
    }
  }

  const additions = tools
    .filter((tool) => !existing.has(tool.name))
    .map((tool) => tool.name);

  if (!additions.length) return catalog;
  if (!catalog) {
    return `\n\nOTHER AVAILABLE TOOLS (call these through use_tool with {tool_name, arguments}; schemas are omitted here to save tokens):\n- demoted_core: ${additions.join(", ")}`;
  }
  return `${catalog}\n- demoted_core: ${additions.join(", ")}`;
}

export function demotedCoreNamesForMessage(text) {
  const demoted = new Set();
  for (const [name, intentPattern] of Object.entries(DEMOTABLE_CORE_TOOLS)) {
    if (!intentPattern.test(text || "")) demoted.add(name);
  }
  return demoted;
}

function compactTier1ForTurn(tier1, text) {
  const kept = [];
  const demoted = [];

  for (const tool of tier1) {
    const intentPattern = DEMOTABLE_CORE_TOOLS[tool.name];
    if (intentPattern && !intentPattern.test(text || "")) {
      demoted.push(tool);
    } else {
      kept.push(tool);
    }
  }

  return { kept, demoted };
}

/**
 * Pick the active tool tiers for this turn.
 *
 * @param {object} opts
 * @param {boolean} opts.isTwinMsg
 * @param {boolean} opts.isOwner
 * @param {string}  opts.cleanMessage
 * @param {string|null} [opts.channelKey]
 * @returns {{ tier1Schemas: object|undefined, tier2CatalogText: string, tier2ToolNames: string[] }}
 *   tier1Schemas — provider-formatted function declarations (or undefined when
 *   there are no Tier-1 tools); tier2CatalogText — the catalog block to append
 *   to the system instruction (empty string when no Tier-2 tools).
 */
export function pickToolProfile({ isTwinMsg, isOwner, cleanMessage, channelKey = null }) {
  const demotedCores = isTwinMsg ? new Set() : demotedCoreNamesForMessage(cleanMessage);
  const { tier1, tier2Catalog, tier2Names } = registry.selectByMessage(cleanMessage, {
    isOwner,
    isTwin: isTwinMsg,
    channelKey,
    demotedCores,
    everyoneTools: EVERYONE_TOOLS,
    ownerTools: OWNER_TOOLS,
  });
  const { kept, demoted } = isTwinMsg
    ? { kept: tier1, demoted: [] }
    : compactTier1ForTurn(tier1, cleanMessage);
  return {
    tier1Schemas: toGeminiTools(kept),
    tier2CatalogText: appendCatalogLines(tier2Catalog, demoted),
    tier2ToolNames: [...(tier2Names || []), ...demoted.map((tool) => tool.name)],
  };
}
