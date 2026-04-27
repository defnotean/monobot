#!/usr/bin/env node
// scaffold-event.js
//
// Scaffolds a discord.js event handler file for either bot.
//
// The two bots use different export shapes for events:
//   eris  → `export default async function eventName(...) { ... }`
//   irene → `export const name = "eventName"; export async function execute(...) { ... }`
//
// This script picks the right shape based on <bot>.
//
// Usage:
//   node scripts/scaffold-event.js <bot> <event_name> [--write]
//
// Example:
//   node scripts/scaffold-event.js irene voiceStateUpdate --write
//
// Refuses to overwrite an existing file.
//
// Exit codes:
//   0 — generated successfully (or dry-ran)
//   1 — bad args / refused to overwrite

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const VALID_BOTS = ["eris", "irene"];

function usage() {
  console.error("Usage: node scripts/scaffold-event.js <bot> <event_name> [--write]");
  console.error("  <bot>        eris | irene");
  console.error("  <event_name> discord.js event name in camelCase, e.g. messageDelete | voiceStateUpdate");
  console.error("  --write      actually write the file (default: dry-run, prints to stdout)");
  process.exit(1);
}

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const positional = argv.filter(a => !a.startsWith("--"));

if (positional.length < 2) usage();

const [bot, eventName] = positional;

if (!VALID_BOTS.includes(bot)) {
  console.error(`[scaffold-event] Unknown bot "${bot}". Must be one of: ${VALID_BOTS.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z][a-zA-Z0-9]*$/.test(eventName)) {
  console.error(`[scaffold-event] Bad event_name "${eventName}". Use camelCase, e.g. messageDelete.`);
  process.exit(1);
}

// ─── Build artifact ──────────────────────────────────────────────────────────

const targetPath = join(ROOT, "packages", bot, "events", `${eventName}.js`);
const targetRel = `packages/${bot}/events/${eventName}.js`;

// Eris uses `export default async function NAME` (matched at registration by
// the function name). Irene uses `export const name + execute` (read explicitly).
const erisContent = `// ─── ${eventName} ─────────────────────────────────────────────────────────
// FILL IN: brief description of what this handler does and why.

import { log } from "../utils/logger.js";

export default async function ${eventName}(...args) {
  // FILL IN: discord.js passes specific arguments per event — see
  // https://discord.js.org/docs/packages/discord.js/main/Events:Enum
  // Replace ...args with the typed signature, e.g.
  //   export default async function messageDelete(message) { ... }
  try {
    // FILL IN handler logic
  } catch (e) {
    log(\`[${eventName}] error: \${e.message}\`);
  }
}
`;

const ireneContent = `// ─── ${eventName} ─────────────────────────────────────────────────────────
// FILL IN: brief description of what this handler does and why.

import { log } from "../utils/logger.js";

export const name = "${eventName}";

export async function execute(...args) {
  // FILL IN: discord.js passes specific arguments per event — see
  // https://discord.js.org/docs/packages/discord.js/main/Events:Enum
  // Replace ...args with the typed signature, e.g.
  //   export async function execute(message) { ... }
  try {
    // FILL IN handler logic
  } catch (e) {
    log(\`[${eventName}] error: \${e.message}\`);
  }
}
`;

const fileContent = bot === "eris" ? erisContent : ireneContent;

// ─── Output ──────────────────────────────────────────────────────────────────

console.log("");
console.log(`# Scaffolding event handler "${eventName}" for ${bot}`);
console.log(`# Mode: ${writeMode ? "WRITE" : "DRY-RUN (use --write to actually create the file)"}`);
console.log("");
console.log(`# Target: ${targetRel}`);
console.log(`# Export style: ${bot === "eris" ? "export default async function (eris convention)" : "export const name + execute (irene convention)"}`);
console.log("");

if (writeMode) {
  if (existsSync(targetPath)) {
    console.error(`[scaffold-event] Refusing to overwrite existing file: ${targetRel}`);
    process.exit(1);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, fileContent, "utf8");
  console.log(`Created: ${targetRel}`);
} else {
  console.log("# --- file content (would be written with --write) ---");
  console.log(fileContent);
}

console.log("");
