#!/usr/bin/env node
import { EVERYONE_TOOLS as ERIS_EVERYONE_TOOLS, OWNER_TOOLS as ERIS_OWNER_TOOLS } from "../packages/eris/ai/tools.js";
import { pickToolProfile } from "../packages/eris/events/messageCreate/toolProfiles.js";
import { ADMIN_TOOLS as IRENE_ADMIN_TOOLS, EVERYONE_TOOLS as IRENE_EVERYONE_TOOLS } from "../packages/irene/ai/tools.js";
import { MAX_TIER1_TOOLS, registry as ireneRegistry } from "../packages/irene/ai/toolRegistry.js";

function size(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function row(profile, selected, accessibleCount, extra = {}) {
  return {
    profile,
    accessibleTools: accessibleCount,
    tier1Tools: selected.tier1.length,
    tier2Tools: selected.tier2Names.length,
    tier2CatalogChars: size(selected.tier2Catalog || ""),
    tier1SchemaJsonChars: size(selected.tier1),
    ...extra,
  };
}

function geminiDeclarationCount(tools) {
  return (tools || []).reduce((sum, group) => sum + (group.functionDeclarations?.length || 0), 0);
}

function erisRow(profile, cleanMessage) {
  const selected = pickToolProfile({
    isTwinMsg: false,
    isOwner: true,
    cleanMessage,
    channelKey: "measure",
  });
  return {
    profile,
    accessibleTools: ERIS_EVERYONE_TOOLS.length + ERIS_OWNER_TOOLS.length,
    tier1Tools: geminiDeclarationCount(selected.tier1Schemas),
    tier2Tools: selected.tier2ToolNames.length,
    tier2CatalogChars: size(selected.tier2CatalogText || ""),
    tier1SchemaJsonChars: size(selected.tier1Schemas || []),
  };
}

const samples = [
  erisRow("eris owner casual", "hey whats up"),
  erisRow("eris owner admin intent", "configure economy and list server features"),
  row(
    "irene admin casual",
    ireneRegistry.selectByMessage("hey whats up", {
      isAdmin: true,
      channelKey: "measure",
      adminTools: IRENE_ADMIN_TOOLS,
      everyoneTools: IRENE_EVERYONE_TOOLS,
    }),
    IRENE_ADMIN_TOOLS.length + IRENE_EVERYONE_TOOLS.length,
    { maxTier1Tools: MAX_TIER1_TOOLS }
  ),
  row(
    "irene admin moderation intent",
    ireneRegistry.selectByMessage("purge messages and check server roles", {
      isAdmin: true,
      channelKey: "measure",
      adminTools: IRENE_ADMIN_TOOLS,
      everyoneTools: IRENE_EVERYONE_TOOLS,
    }),
    IRENE_ADMIN_TOOLS.length + IRENE_EVERYONE_TOOLS.length,
    { maxTier1Tools: MAX_TIER1_TOOLS }
  ),
];

console.table(samples);
console.log(JSON.stringify(Object.fromEntries(samples.map((entry) => [entry.profile, entry])), null, 2));
