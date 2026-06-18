// Owner-only guarded self-repair workflow.
//
// This intentionally does not expose arbitrary shell. The model may propose a
// unified diff and a small allowlisted test plan; this executor validates the
// patch, applies it with git, runs checks, and only then optionally schedules a
// restart. Disabled by default via SELF_REPAIR_ENABLED.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../../config.js";
import { log } from "../../utils/logger.js";

const HANDLED = new Set(["self_repair"]);
const REPO_ROOT = resolve(process.cwd());
const MAX_PATCH_CHARS = 80_000;
const MAX_COMMANDS = 6;
const MAX_DIAGNOSTIC_CHARS = 7_000;
const MAX_CONTEXT_FILES = 6;
const MAX_CONTEXT_FILE_CHARS = 1_300;
const SOURCE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ts", ".tsx", ".yml", ".yaml",
]);
const BASE_TEST_COMMANDS = [
  "npm run lint",
];

const ALLOWED_PATH_PREFIXES = [
  "docs/",
  "scripts/",
  "packages/eris/",
  "packages/irene/",
  "packages/shared/",
];
const ALLOWED_ROOT_FILES = new Set([
  "README.md",
  "eslint.config.js",
]);
const BLOCKED_PATH_PARTS = [
  ".git/",
  ".gcloud-config/",
  ".tools/",
  "node_modules/",
  "dist/",
  "coverage/",
];
const SECRET_BASENAME_RE = /^\.env(?:$|\.(?!example$))|\.pem$|\.key$|id_rsa$|id_ed25519$|secrets?\.json$/i;
const ISSUE_FILE_HINTS = [
  {
    pattern: /\b(tts|text.?to.?speech|piper|voice|audio|music)\b/i,
    files: [
      "packages/irene/events/messageCreate/passiveFeatures.js",
      "packages/irene/ai/executors/audioExecutor.js",
      "packages/irene/music/player.js",
      "packages/irene/config.js",
    ],
  },
  {
    pattern: /\b(image|vision|screenshot|attachment|sticker|gif|ollama|photo|picture)\b/i,
    files: [
      "packages/shared/src/ai/localVision.js",
      "packages/irene/events/messageCreate/contextBuild.js",
      "packages/eris/events/messageCreate/contextBuild.js",
      "packages/irene/config.js",
    ],
  },
  {
    pattern: /\b(dashboard|admin panel|stats|memory|transaction|balance|relationship|conversation)\b/i,
    files: [
      "packages/irene/presence.js",
      "packages/eris/presence.js",
      "packages/irene/database.js",
      "packages/eris/database.js",
    ],
  },
  {
    pattern: /\b(self.?repair|auto.?fix|patch|diagnose|restart|codebase|bug)\b/i,
    files: [
      "packages/irene/ai/executors/selfRepairExecutor.js",
      "packages/irene/ai/executor.js",
      "packages/irene/ai/dual.js",
      "packages/irene/ai/tools/adminTools.js",
      "packages/irene/ai/toolRegistry.js",
    ],
  },
];

function splitCommand(command) {
  return String(command || "").trim().split(/\s+/).filter(Boolean);
}

function repoRelativePath(rawPath) {
  let value = String(rawPath || "").trim();
  if (!value || value === "/dev/null") return "";
  value = value.replace(/^"(.*)"$/, "$1");
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  return value.replace(/\\/g, "/");
}

function fileExtension(path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function isAllowedRepoPath(path) {
  return validateSelfRepairPatch(`diff --git a/${path} b/${path}\n`).ok;
}

function isSearchableSource(path) {
  return isAllowedRepoPath(path) && SOURCE_EXTENSIONS.has(fileExtension(path));
}

export function extractPatchPaths(patch) {
  const paths = new Set();
  for (const line of String(patch || "").split("\n")) {
    let match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
    if (match) {
      paths.add(repoRelativePath(match[1]));
      paths.add(repoRelativePath(match[2]));
      continue;
    }
    match = line.match(/^(?:---|\+\+\+)\s+(.+)$/);
    if (match) paths.add(repoRelativePath(match[1].split(/\t/)[0]));
  }
  return [...paths].filter(Boolean);
}

export function validateSelfRepairPatch(patch) {
  const text = String(patch || "");
  if (!text.trim()) return { ok: false, error: "patch is required" };
  if (text.length > MAX_PATCH_CHARS) return { ok: false, error: `patch too large; max ${MAX_PATCH_CHARS} chars` };
  if (!/^diff --git /m.test(text) && !/^---\s+/m.test(text)) {
    return { ok: false, error: "patch must be a unified diff" };
  }

  const paths = extractPatchPaths(text);
  if (!paths.length) return { ok: false, error: "patch has no file paths" };
  for (const p of paths) {
    if (p.startsWith("/") || p.includes("../") || p === "..") {
      return { ok: false, error: `unsafe path: ${p}` };
    }
    const lower = p.toLowerCase();
    if (BLOCKED_PATH_PARTS.some((part) => lower.includes(part))) {
      return { ok: false, error: `blocked path: ${p}` };
    }
    if (SECRET_BASENAME_RE.test(basename(p))) {
      return { ok: false, error: `secret/env path blocked: ${p}` };
    }
    if (!ALLOWED_ROOT_FILES.has(p) && !ALLOWED_PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) {
      return { ok: false, error: `path outside self-repair allowlist: ${p}` };
    }
  }
  return { ok: true, paths };
}

export function isAllowedSelfRepairCommand(command) {
  const parts = splitCommand(command);
  if (!parts.length) return false;
  if (parts[0] === "git") {
    return parts.length === 3 && parts[1] === "diff" && parts[2] === "--check";
  }
  if (parts[0] === "node") {
    const target = repoRelativePath(parts[2] || "");
    return parts.length === 3 && parts[1] === "--check" && validateSelfRepairPatch(`diff --git a/${target} b/${target}`).ok;
  }
  if (parts[0] !== "npm") return false;
  if (parts[1] === "run" && ["lint", "build"].includes(parts[2])) {
    if (parts.length === 3) return true;
    return parts.length === 4 && parts[3].startsWith("--workspace=@defnotean/");
  }
  if (parts[1] === "test") {
    if (parts.length === 2) return true;
    if (parts[2]?.startsWith("--workspace=@defnotean/")) return parts.length <= 6;
  }
  return false;
}

export function defaultTestCommandsForPaths(paths = []) {
  const commands = [...BASE_TEST_COMMANDS];
  const touched = paths.map(String);
  const needsShared = touched.some((p) => p.startsWith("packages/shared/"));
  const needsIrene = touched.some((p) => p.startsWith("packages/irene/"));
  const needsEris = touched.some((p) => p.startsWith("packages/eris/"));

  if (needsShared) {
    commands.push("npm run build --workspace=@defnotean/shared");
    commands.push("npm test --workspace=@defnotean/shared");
  }
  if (needsIrene) {
    commands.push("npm run build --workspace=@defnotean/irene");
    commands.push("npm test --workspace=@defnotean/irene");
  }
  if (needsEris) {
    commands.push("npm run build --workspace=@defnotean/eris");
    commands.push("npm test --workspace=@defnotean/eris");
  }
  return commands.slice(0, MAX_COMMANDS);
}

function runFile(command, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = execFile(command, args, {
      cwd: REPO_ROOT,
      timeout: timeoutMs,
      maxBuffer: 1_500_000,
    }, (error, stdout = "", stderr = "") => {
      resolvePromise({
        ok: !error,
        code: error?.code ?? 0,
        output: `${stdout}${stderr}`.trim().slice(-4000),
      });
    });
    child.on("error", (error) => {
      resolvePromise({ ok: false, code: -1, output: error.message });
    });
  });
}

async function runAllowedCommand(command) {
  if (!isAllowedSelfRepairCommand(command)) {
    return { ok: false, command, output: "command is not on the self-repair allowlist" };
  }
  const [bin, ...args] = splitCommand(command);
  const result = await runFile(bin, args);
  return { command, ...result };
}

async function recentLogSummary() {
  const paths = [
    "/home/defnotean/.local/monobot-logs/irene.log",
    "/home/defnotean/.local/monobot-logs/eris.log",
  ];
  const out = [];
  for (const file of paths) {
    try {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n").slice(-120)
        .filter((line) => /\b(error|failed|timeout|tts|vision|image|piper|ollama|exception)\b/i.test(line))
        .slice(-12);
      if (lines.length) out.push(`${basename(file)}:\n${lines.join("\n")}`);
    } catch {
      // Missing logs are not fatal.
    }
  }
  return out.join("\n\n").slice(-6000) || "no recent matching log lines";
}

function hintedFilesForIssue(issue) {
  const text = String(issue || "");
  const files = [];
  for (const hint of ISSUE_FILE_HINTS) {
    if (hint.pattern.test(text)) files.push(...hint.files);
  }
  return files;
}

async function readDiagnosticFile(path) {
  const rel = repoRelativePath(path);
  if (!isSearchableSource(rel)) return "";
  try {
    const text = await readFile(resolve(REPO_ROOT, rel), "utf8");
    const lower = text.toLowerCase();
    const needles = [
      "self_repair",
      "getimageattachments",
      "describeimageattachments",
      "localvision",
      "detectttstoggleshortcut",
      "say_tts",
      "tts",
      "piper",
      "dashboard",
      "memory",
    ];
    const hit = needles
      .map((needle) => lower.indexOf(needle))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    const start = Math.max(0, (hit ?? 0) - 350);
    return `${rel}:\n${text.slice(start, start + MAX_CONTEXT_FILE_CHARS)}`;
  } catch {
    return "";
  }
}

async function collectDiagnosticContext({ issue, files = [] }) {
  const requested = Array.isArray(files) ? files.map(repoRelativePath) : [];
  const candidates = [...new Set([...requested, ...hintedFilesForIssue(issue)])]
    .filter(isSearchableSource)
    .slice(0, MAX_CONTEXT_FILES);
  const sections = [];
  for (const file of candidates) {
    const section = await readDiagnosticFile(file);
    if (section) sections.push(section);
  }
  return sections.join("\n\n").slice(0, MAX_DIAGNOSTIC_CHARS);
}

async function notifyOwner(message, text) {
  const body = String(text || "").slice(0, 1800);
  if (!body || message?.author?.id !== config.ownerId) return false;
  try {
    await message.author?.send?.(body);
    return true;
  } catch {
    try {
      await message.channel?.send?.(body);
      return true;
    } catch {
      return false;
    }
  }
}

function scheduleRestart(bot = "irene", delayMs = 15_000) {
  const service = bot === "both"
    ? ["monobot-eris.service", "monobot-irene.service"]
    : [`monobot-${bot}.service`];
  setTimeout(() => {
    const child = execFile("systemctl", ["--user", "restart", ...service], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    }, (error) => {
      if (error) log(`[SelfRepair] restart failed: ${error.message}`);
    });
    child.unref?.();
  }, Math.max(5_000, delayMs)).unref?.();
}

async function applyRepairPatch(input = {}, message) {
  const { patch, test_commands: testCommands, restart, restart_bot: restartBot, notify_owner: notify } = input;
  if (!config.local?.selfRepairEnabled) {
    return "self-repair apply is disabled. set SELF_REPAIR_ENABLED=1 and restart Irene to allow guarded patch application.";
  }

  const validation = validateSelfRepairPatch(patch);
  if (!validation.ok) return `self-repair rejected patch: ${validation.error}`;
  const paths = validation.paths || [];

  const commands = Array.isArray(testCommands) && testCommands.length
    ? testCommands.slice(0, MAX_COMMANDS).map(String)
    : defaultTestCommandsForPaths(paths);
  const blocked = commands.find((cmd) => !isAllowedSelfRepairCommand(cmd));
  if (blocked) return `self-repair rejected test command: ${blocked}`;

  if (notify !== false) {
    await notifyOwner(message, `self-repair: patch validated for ${paths.join(", ")}. running checks now.`);
  }

  const patchPath = `/tmp/irene-self-repair-${randomUUID()}.patch`;
  await writeFile(patchPath, patch, "utf8");

  const check = await runFile("git", ["apply", "--check", patchPath]);
  if (!check.ok) return `patch did not apply cleanly:\n${check.output}`;

  const apply = await runFile("git", ["apply", patchPath]);
  if (!apply.ok) return `git apply failed:\n${apply.output}`;

  const results = [];
  for (const command of ["git diff --check", ...commands]) {
    const result = await runAllowedCommand(command);
    results.push(result);
    if (!result.ok) {
      await runFile("git", ["apply", "-R", patchPath]);
      if (notify !== false) {
        await notifyOwner(message, `self-repair: checks failed on ${command}; reverted the patch.`);
      }
      return [
        `self-repair tests failed; reverted patch. failing command: ${command}`,
        result.output,
      ].join("\n").trim();
    }
  }

  const summary = [
    `self-repair patch applied to ${paths.length} file(s): ${paths.join(", ")}`,
    `checks passed: ${results.map((r) => r.command).join("; ")}`,
  ];
  if (restart && config.local?.selfRepairAllowRestart) {
    const bot = restartBot === "eris" || restartBot === "both" ? restartBot : "irene";
    scheduleRestart(bot);
    summary.push(`restart scheduled for ${bot} in 15s`);
  } else if (restart) {
    summary.push("restart requested but SELF_REPAIR_ALLOW_RESTART is not enabled");
  }
  if (notify !== false) {
    await notifyOwner(message, `self-repair applied. ${summary.join(" ")}`);
  }
  return summary.join("\n");
}

export async function execute(toolName, input = {}, message) {
  if (!HANDLED.has(toolName)) return undefined;
  if (message?.author?.id !== config.ownerId) return "only the bot owner can use self-repair";

  const mode = String(input.mode || "diagnose").toLowerCase();
  if (mode === "diagnose" || mode === "auto") {
    const logs = await recentLogSummary();
    const codeContext = await collectDiagnosticContext({
      issue: input.issue,
      files: input.files,
    });
    return [
      mode === "auto" ? "self-repair auto workflow started:" : "self-repair diagnostic context:",
      `issue: ${String(input.issue || "not specified").slice(0, 500)}`,
      logs,
      codeContext ? `source context:\n${codeContext}` : "source context: no matching files found",
      mode === "auto"
        ? "next: identify the likely cause, create a minimal unified diff, call self_repair with mode='apply', include focused tests, set restart=true when checks pass, then tell the owner what broke, what changed, which checks passed, and whether a restart was scheduled. if the patch cannot be made safely, stop and explain why."
        : "next: propose a unified diff plus focused tests, then call self_repair with mode='apply'.",
    ].join("\n\n");
  }
  if (mode === "check") {
    const validation = validateSelfRepairPatch(input.patch || "");
    if (!validation.ok) return `self-repair rejected patch: ${validation.error}`;
    const paths = validation.paths || [];
    const commands = Array.isArray(input.test_commands) && input.test_commands.length
      ? input.test_commands.map(String)
      : defaultTestCommandsForPaths(paths);
    const blocked = commands.find((cmd) => !isAllowedSelfRepairCommand(cmd));
    if (blocked) return `self-repair rejected test command: ${blocked}`;
    return `self-repair patch is structurally allowed for: ${paths.join(", ")}\nchecks allowed: ${commands.join("; ")}`;
  }
  if (mode === "apply") return applyRepairPatch(input, message);
  return "unknown self_repair mode; use auto, diagnose, check, or apply";
}

export const _test = {
  extractPatchPaths,
  validateSelfRepairPatch,
  isAllowedSelfRepairCommand,
  defaultTestCommandsForPaths,
};
