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

/**
 * Pick the active tool tiers for this turn.
 *
 * @param {object} opts
 * @param {boolean} opts.isTwinMsg
 * @param {boolean} opts.isOwner
 * @param {string}  opts.cleanMessage
 * @param {string}  [opts.channelKey]
 * @returns {{ tier1Schemas: object|undefined, tier2CatalogText: string }}
 *   tier1Schemas — provider-formatted function declarations (or undefined when
 *   there are no Tier-1 tools); tier2CatalogText — the catalog block to append
 *   to the system instruction (empty string when no Tier-2 tools).
 */
export function pickToolProfile({ isTwinMsg, isOwner, cleanMessage, channelKey = null }) {
  const { tier1, tier2Catalog } = registry.selectByMessage(cleanMessage, {
    isOwner,
    isTwin: isTwinMsg,
    channelKey,
    everyoneTools: EVERYONE_TOOLS,
    ownerTools: OWNER_TOOLS,
  });
  return {
    tier1Schemas: toGeminiTools(tier1),
    tier2CatalogText: tier2Catalog,
  };
}
