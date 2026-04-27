#!/usr/bin/env node
// scaffold-command.js
//
// Scaffolds a Discord slash command file for either bot.
//
// Usage:
//   node scripts/scaffold-command.js <bot> <category> <command_name> [--write]
//
// Example:
//   node scripts/scaffold-command.js irene fun joke --write
//
// In dry-run, prints to stdout. In write mode, creates the file at:
//   packages/<bot>/commands/<category>/<command_name>.js
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
  console.error("Usage: node scripts/scaffold-command.js <bot> <category> <command_name> [--write]");
  console.error("  <bot>          eris | irene");
  console.error("  <category>     subdirectory under commands/, e.g. fun | utility | mod");
  console.error("  <command_name> slash-command name, lowercase, e.g. joke");
  console.error("  --write        actually write the file (default: dry-run, prints to stdout)");
  process.exit(1);
}

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const positional = argv.filter(a => !a.startsWith("--"));

if (positional.length < 3) usage();

const [bot, category, commandName] = positional;

if (!VALID_BOTS.includes(bot)) {
  console.error(`[scaffold-command] Unknown bot "${bot}". Must be one of: ${VALID_BOTS.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z][a-z0-9_-]*$/.test(category)) {
  console.error(`[scaffold-command] Bad category "${category}". Must be lowercase identifier.`);
  process.exit(1);
}
// Discord requires command names to be 1-32 chars, lowercase, [a-z0-9_-].
if (!/^[a-z][a-z0-9_-]{0,31}$/.test(commandName)) {
  console.error(`[scaffold-command] Bad command_name "${commandName}". Discord requires lowercase 1-32 chars: [a-z0-9_-].`);
  process.exit(1);
}

// ─── Build artifact ──────────────────────────────────────────────────────────

const targetPath = join(ROOT, "packages", bot, "commands", category, `${commandName}.js`);
const targetRel = `packages/${bot}/commands/${category}/${commandName}.js`;

const fileContent = `import { SlashCommandBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("${commandName}")
  .setDescription("FILL IN: short user-facing description (under 100 chars)");

export async function execute(interaction) {
  // FILL IN: command logic. Common patterns:
  //   - interaction.options.getString("name") to read options
  //   - interaction.deferReply() if work takes >3s
  //   - interaction.reply({ content: "...", flags: 64 }) for ephemeral replies
  await interaction.reply({ content: "FILL IN response", flags: 64 });
}
`;

// ─── Output ──────────────────────────────────────────────────────────────────

console.log("");
console.log(`# Scaffolding command "/${commandName}" for ${bot} (category: ${category})`);
console.log(`# Mode: ${writeMode ? "WRITE" : "DRY-RUN (use --write to actually create the file)"}`);
console.log("");
console.log(`# Target: ${targetRel}`);
console.log("");

if (writeMode) {
  if (existsSync(targetPath)) {
    console.error(`[scaffold-command] Refusing to overwrite existing file: ${targetRel}`);
    process.exit(1);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, fileContent, "utf8");
  console.log(`Created: ${targetRel}`);
  console.log(`Don't forget: npm run deploy --workspace=@defnotean/${bot}`);
} else {
  console.log("# --- file content (would be written with --write) ---");
  console.log(fileContent);
  console.log(`# After --write you'll need: npm run deploy --workspace=@defnotean/${bot}`);
}

console.log("");
