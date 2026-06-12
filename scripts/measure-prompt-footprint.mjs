#!/usr/bin/env node

process.env.DISCORD_TOKEN ||= "measure";
process.env.CLIENT_ID ||= "0";
process.env.DISCORD_BOT_TOKEN ||= "measure";
process.env.DISCORD_CLIENT_ID ||= "0";
process.env.GEMINI_API_KEY ||= "x";

const [
  erisTools,
  erisRegistryModule,
  ireneTools,
  ireneRegistryModule,
] = await Promise.all([
  import("../packages/eris/ai/tools.js"),
  import("../packages/eris/ai/toolRegistry.js"),
  import("../packages/irene/ai/tools.js"),
  import("../packages/irene/ai/toolRegistry.js"),
]);

const { EVERYONE_TOOLS: ERIS_EVERYONE_TOOLS, OWNER_TOOLS: ERIS_OWNER_TOOLS } = erisTools;
const { registry: erisRegistry } = erisRegistryModule;
const { ADMIN_TOOLS: IRENE_ADMIN_TOOLS, EVERYONE_TOOLS: IRENE_EVERYONE_TOOLS } = ireneTools;
const { MAX_TIER1_TOOLS, registry: ireneRegistry } = ireneRegistryModule;

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

function toMeasureGeminiTools(tools) {
  if (!tools || !tools.length) return undefined;
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
    })),
  }];
}

function erisRow(profile, cleanMessage) {
  const selected = erisRegistry.selectByMessage(cleanMessage, {
    isOwner: true,
    channelKey: "measure",
    everyoneTools: ERIS_EVERYONE_TOOLS,
    ownerTools: ERIS_OWNER_TOOLS,
  });
  const tier1Schemas = toMeasureGeminiTools(selected.tier1);
  return {
    profile,
    accessibleTools: ERIS_EVERYONE_TOOLS.length + ERIS_OWNER_TOOLS.length,
    tier1Tools: geminiDeclarationCount(tier1Schemas),
    tier2Tools: selected.tier2Names.length,
    tier2CatalogChars: size(selected.tier2Catalog || ""),
    tier1SchemaJsonChars: size(tier1Schemas || []),
  };
}

function ireneRow(profile, cleanMessage) {
  return row(
    profile,
    ireneRegistry.selectByMessage(cleanMessage, {
      isAdmin: true,
      channelKey: "measure",
      adminTools: IRENE_ADMIN_TOOLS,
      everyoneTools: IRENE_EVERYONE_TOOLS,
    }),
    IRENE_ADMIN_TOOLS.length + IRENE_EVERYONE_TOOLS.length,
    { maxTier1Tools: MAX_TIER1_TOOLS }
  );
}

const samples = [
  erisRow("eris owner casual", "hey whats up"),
  erisRow("eris owner admin intent", "configure economy and list server features"),
  ireneRow("irene admin casual", "hey whats up"),
  ireneRow("irene admin moderation intent", "purge messages and check server roles"),
];

console.table(samples);
const byProfile = Object.fromEntries(samples.map((entry) => [entry.profile, entry]));
console.log(JSON.stringify(byProfile, null, 2));
console.log(`MEASURE_PROMPT_FOOTPRINT_JSON=${JSON.stringify(byProfile)}`);
