#!/usr/bin/env node
// scaffold-executor.js
//
// Scaffolds a fresh sub-executor module under packages/<bot>/ai/executors/.
//
// Sub-executor contract (matches every existing one in the repo):
//   - Exports `execute(toolName, input, message, ctx)`
//   - Owns a `HANDLED` Set of tool names it answers for
//   - Returns undefined for tools NOT in HANDLED so the main executor falls
//     through to the next sub-executor in SUB_EXECUTORS
//   - Returns a string (or whatever the contract requires) for tools it owns
//
// The script does NOT auto-edit packages/<bot>/ai/executor.js — that file is
// hand-curated and the order of SUB_EXECUTORS matters (first non-undefined
// wins). Instead it prints the exact import + array entry to add manually.
//
// Usage:
//   node scripts/scaffold-executor.js <bot> <domain_name> [--write]
//
// Example:
//   node scripts/scaffold-executor.js eris payment --write
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
  console.error("Usage: node scripts/scaffold-executor.js <bot> <domain_name> [--write]");
  console.error("  <bot>         eris | irene");
  console.error("  <domain_name> camelCase basename (no 'Executor.js' suffix), e.g. payment | analytics");
  console.error("  --write       actually write the file (default: dry-run, prints to stdout)");
  process.exit(1);
}

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const positional = argv.filter(a => !a.startsWith("--"));

if (positional.length < 2) usage();

const [bot, domainName] = positional;

if (!VALID_BOTS.includes(bot)) {
  console.error(`[scaffold-executor] Unknown bot "${bot}". Must be one of: ${VALID_BOTS.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z][a-zA-Z0-9]*$/.test(domainName)) {
  console.error(`[scaffold-executor] Bad domain_name "${domainName}". Use camelCase basename (no 'Executor.js' suffix).`);
  process.exit(1);
}

// ─── Build artifact ──────────────────────────────────────────────────────────

const fileBasename = `${domainName}Executor.js`;
const targetPath = join(ROOT, "packages", bot, "ai", "executors", fileBasename);
const targetRel = `packages/${bot}/ai/executors/${fileBasename}`;
const importIdentifier = `execute${domainName.charAt(0).toUpperCase()}${domainName.slice(1)}`;
const titleName = domainName.charAt(0).toUpperCase() + domainName.slice(1);

const fileContent = `// ─── ${titleName} Sub-Executor ──────────────────────────────────────────────
// Handles: FILL IN list of tool names this executor owns.
// Called from main executor.js via delegation. Returns undefined for tools
// not in HANDLED so the router falls through to the next sub-executor.

// import * as db from "../../database.js";
// import { log } from "../../utils/logger.js";

const HANDLED = new Set([
  // FILL IN: list every tool name (snake_case) this executor handles.
  // e.g. "do_thing", "list_things", "delete_thing",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {
    // FILL IN cases. Each case must return a string.
    //
    // case "do_thing": {
    //   // ...
    //   return "did the thing";
    // }

    default:
      // Defensive: HANDLED says we own it but no case matched. Surface the
      // bug as a string so the AI doesn't think the call silently succeeded.
      return \`[${domainName}Executor] no handler for "\${toolName}" — add a case or remove from HANDLED\`;
  }
}
`;

// ─── Output ──────────────────────────────────────────────────────────────────

console.log("");
console.log(`# Scaffolding sub-executor "${domainName}Executor.js" for ${bot}`);
console.log(`# Mode: ${writeMode ? "WRITE" : "DRY-RUN (use --write to actually create the file)"}`);
console.log("");
console.log(`# Target: ${targetRel}`);
console.log("");

if (writeMode) {
  if (existsSync(targetPath)) {
    console.error(`[scaffold-executor] Refusing to overwrite existing file: ${targetRel}`);
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
console.log(`# Now register it in packages/${bot}/ai/executor.js:`);
console.log("");
console.log(`#   1. Add this import alongside the other sub-executor imports:`);
console.log("");
console.log(`import { execute as ${importIdentifier} } from "./executors/${domainName}Executor.js";`);
console.log("");
console.log(`#   2. Add ${importIdentifier} to the SUB_EXECUTORS array.`);
console.log(`#      Order matters — first non-undefined result wins. Place it`);
console.log(`#      before any other executor whose HANDLED set might overlap.`);
console.log("");
console.log(`      ${importIdentifier},`);
console.log("");
