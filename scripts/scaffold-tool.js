#!/usr/bin/env node
// scaffold-tool.js
//
// Scaffolds the three artifacts needed to add a new AI tool to either bot:
//   1. Schema STUB    — printed to stdout, paste into packages/<bot>/ai/tools.js
//   2. Executor case  — printed to stdout, paste into the chosen sub-executor
//   3. Test file      — actually written to disk (in --write mode)
//
// Why two of three are stdout-only:
//   tools.js and the executor switch statements are big, hand-curated files
//   organized into category sections. Auto-inserting at the wrong line would
//   silently corrupt them. The human paste step is the safety net.
//
// Usage:
//   node scripts/scaffold-tool.js <bot> <tool_name> <executor_basename> [--write]
//
// Example:
//   node scripts/scaffold-tool.js eris send_compliment misc --write
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
  console.error("Usage: node scripts/scaffold-tool.js <bot> <tool_name> <executor_basename> [--write]");
  console.error("  <bot>               eris | irene");
  console.error("  <tool_name>         snake_case, e.g. send_compliment");
  console.error("  <executor_basename> sub-executor file basename WITHOUT 'Executor.js' suffix, e.g. misc");
  console.error("  --write             actually write files (default: dry-run, prints to stdout)");
  process.exit(1);
}

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const positional = argv.filter(a => !a.startsWith("--"));

if (positional.length < 3) usage();

const [bot, toolName, executorBasename] = positional;

if (!VALID_BOTS.includes(bot)) {
  console.error(`[scaffold-tool] Unknown bot "${bot}". Must be one of: ${VALID_BOTS.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
  console.error(`[scaffold-tool] Bad tool_name "${toolName}". Must be snake_case (lowercase, digits, underscores).`);
  process.exit(1);
}
if (!/^[a-z][a-zA-Z0-9]*$/.test(executorBasename)) {
  console.error(`[scaffold-tool] Bad executor_basename "${executorBasename}". Must be camelCase basename (no 'Executor.js' suffix).`);
  process.exit(1);
}

// ─── Build artifacts ─────────────────────────────────────────────────────────

const toolsPath = `packages/${bot}/ai/tools.js`;
const executorPath = `packages/${bot}/ai/executors/${executorBasename}Executor.js`;

const schemaStub = `  {
    name: "${toolName}",
    description: "FILL IN: imperative description with concrete trigger examples — e.g. 'Use when someone says X, Y, or Z'.",
    input_schema: {
      type: "object",
      properties: {
        // FILL IN: each property gets { type, description }
      },
      required: [],
    },
  },`;

const caseStub = `    case "${toolName}": {
      // FILL IN handler logic. Read input.* fields, do work, return a string.
      // Sub-executor contract: must return a string (or undefined to fall
      // through to the next sub-executor — but if we got here, this tool
      // is in HANDLED so always return a string).
      return "FILL IN result string";
    }`;

// Test file path differs by bot (matches existing convention)
const testFilePath = bot === "eris"
  ? join(ROOT, "packages", "eris", "tests", "ai", `${toolName}.test.ts`)
  : join(ROOT, "packages", "irene", "tests", "ai", "executors", `${toolName}.test.ts`);
const testFileRel = bot === "eris"
  ? `packages/eris/tests/ai/${toolName}.test.ts`
  : `packages/irene/tests/ai/executors/${toolName}.test.ts`;

// Per-bot test templates — Eris executor tests import directly from the
// sub-executor; Irene tests dispatch through the public executeTool entry.
const erisTestContent = `// Test for the "${toolName}" tool handler.
//
// Reference: packages/eris/tests/ai/getMoodTool.test.ts (the canonical example).
//
// Pattern:
//   1. Mock ../../database.js (and any other modules the handler imports)
//      BEFORE importing the executor, otherwise the real module loads first
//      and tries to talk to Supabase.
//   2. Build the smallest plausible \`message\` the handler reads from.
//   3. Test the input/output contract — handler-specific branches and
//      the sub-executor "undefined for foreign tools" contract.

import { describe, it, expect, vi } from "vitest";

// FILL IN: stub only what the handler actually reaches for.
vi.mock("../../database.js", () => ({
  // example: getSomething: () => ({ ... }),
}));

// @ts-expect-error - importing JS module without types
import { execute } from "../../ai/executors/${executorBasename}Executor.js";

const fakeMessage = {
  author: { id: "u-test", username: "tester" },
  // Add channel / guild / member only if the handler reads them.
} as any;

describe("${toolName} tool handler", () => {
  it("FILL IN: happy path", async () => {
    const result = await execute("${toolName}", { /* FILL IN args */ }, fakeMessage, {});
    expect(result).toBe("FILL IN expected output");
  });

  it("returns undefined for tools the ${executorBasename} executor does not own", async () => {
    // Sub-executor contract: return undefined when the tool isn't in HANDLED.
    const result = await execute("not_a_real_tool", {}, fakeMessage, {});
    expect(result).toBeUndefined();
  });
});
`;

const ireneTestContent = `// Test for the "${toolName}" tool handler.
//
// Reference: packages/irene/tests/ai/executors/listEmojis.test.ts (the canonical example).
//
// Pattern:
//   1. Dispatch through the public executeTool entry — same path the AI
//      takes at runtime, so router + handler are exercised together.
//   2. Build a minimal fake \`message\` (author + guild) — only stub the
//      Discord.js surface the handler actually touches.
//   3. Use a unique guildId per test so the executor's read-tool cache
//      (15s window, keyed by guildId+toolName+args) doesn't bleed results
//      between tests.

import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { executeTool } from "../../../ai/executor.js";

function fakeMessage(guildId: string) {
  return {
    author: { id: \`user-\${guildId}\`, username: "tester" },
    guild: {
      id: guildId,
      // FILL IN: stub only the guild surface the handler reads.
      // e.g. emojis: { cache: ... }, members: { cache: ... }, channels: { cache: ... }
    },
    // FILL IN: add channel / member if the handler needs them.
  };
}

describe("${toolName} tool handler", () => {
  it("FILL IN: happy path", async () => {
    const msg = fakeMessage("g-happy");
    const result = await executeTool("${toolName}", { /* FILL IN args */ }, msg);
    expect(result).toBe("FILL IN expected output");
  });
});
`;

const testContent = bot === "eris" ? erisTestContent : ireneTestContent;

// ─── Output ──────────────────────────────────────────────────────────────────

console.log("");
console.log(`# Scaffolding tool "${toolName}" for ${bot} → ${executorBasename}Executor.js`);
console.log(`# Mode: ${writeMode ? "WRITE" : "DRY-RUN (use --write to actually create files)"}`);
console.log("");

console.log(`# 1. Schema STUB — paste into ${toolsPath} under the appropriate category section:`);
console.log("");
console.log(schemaStub);
console.log("");

console.log(`# 2. Executor case — paste into the switch statement in ${executorPath}.`);
console.log(`#    Also add "${toolName}" to the HANDLED Set at the top of that file.`);
console.log("");
console.log(caseStub);
console.log("");

console.log(`# 3. Test file: ${testFileRel}`);
if (writeMode) {
  if (existsSync(testFilePath)) {
    console.error(`[scaffold-tool] Refusing to overwrite existing test file: ${testFileRel}`);
    process.exit(1);
  }
  mkdirSync(dirname(testFilePath), { recursive: true });
  writeFileSync(testFilePath, testContent, "utf8");
  console.log(`#    Created: ${testFileRel}`);
} else {
  console.log("#    --- test file content (would be written with --write) ---");
  console.log(testContent);
}

console.log("");
console.log("# Next steps:");
console.log(`#  - Paste the schema into ${toolsPath}.`);
console.log(`#  - Paste the case into ${executorPath} and add "${toolName}" to its HANDLED Set.`);
console.log(`#  - Fill in the test file at ${testFileRel}.`);
console.log(`#  - Run: npm test --workspace=@defnotean/${bot}`);
console.log("");
