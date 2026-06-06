#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const localGcloud = path.join(repoRoot, ".tools", "google-cloud-sdk", "bin", "gcloud");
const defaultCloudConfig = path.join(repoRoot, ".gcloud-config");

const SERVICES = [
  "serviceusage.googleapis.com",
  "apikeys.googleapis.com",
  "generativelanguage.googleapis.com",
];

const BOT_ENV_FILES = {
  eris: path.join(repoRoot, "packages", "eris", ".env"),
  irene: path.join(repoRoot, "packages", "irene", ".env"),
};

const GEMINI_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
];

function parseArgs(argv) {
  const opts = {
    botKeys: 4,
    dryRun: false,
    enableServices: true,
    keyPrefix: "monobot",
    gcloud: process.env.GCLOUD_BIN || "",
    cloudConfig: process.env.CLOUDSDK_CONFIG || defaultCloudConfig,
    project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--project") opts.project = readValue();
    else if (arg === "--bot-keys") opts.botKeys = Number(readValue());
    else if (arg === "--key-prefix") opts.keyPrefix = readValue();
    else if (arg === "--gcloud") opts.gcloud = readValue();
    else if (arg === "--cloudsdk-config") opts.cloudConfig = readValue();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-enable-services") opts.enableServices = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(opts.botKeys) || opts.botKeys < 1 || opts.botKeys > 4) {
    throw new Error("--bot-keys must be an integer from 1 to 4");
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/provision-google-gemini-keys.mjs [options]

Creates restricted Gemini API keys in Google Cloud and writes them to:
  packages/eris/.env
  packages/irene/.env

Options:
  --project <id>             Google Cloud project ID. Defaults to gcloud config.
  --bot-keys <n>             Keys per bot, 1-4. Default: 4.
  --key-prefix <prefix>      Display-name prefix. Default: monobot.
  --gcloud <path>            gcloud binary. Defaults to local .tools SDK or PATH.
  --cloudsdk-config <path>   gcloud config directory. Default: .gcloud-config.
  --skip-enable-services     Do not run gcloud services enable.
  --dry-run                  Print planned display names without creating keys.
`);
}

function findGcloud(explicitPath) {
  if (explicitPath) return explicitPath;
  if (existsSync(localGcloud)) return localGcloud;

  const found = spawnSync("bash", ["-lc", "command -v gcloud"], {
    encoding: "utf8",
  });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();

  throw new Error(
    "gcloud is not installed. Install Google Cloud CLI or place it at .tools/google-cloud-sdk/bin/gcloud.",
  );
}

function gcloudEnv(opts) {
  return {
    ...process.env,
    CLOUDSDK_CONFIG: opts.cloudConfig,
  };
}

function runGcloud(opts, args, { json = false, secret = false } = {}) {
  const result = spawnSync(opts.gcloud, args, {
    cwd: repoRoot,
    env: gcloudEnv(opts),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });

  if (result.status !== 0) {
    const stderr = secret ? "[redacted]" : result.stderr.trim();
    const stdout = secret ? "[redacted]" : result.stdout.trim();
    throw new Error(
      `gcloud ${args.join(" ")} failed with exit ${result.status}\n${stderr || stdout}`,
    );
  }

  const text = result.stdout.trim();
  if (!json) return text;
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON from gcloud ${args.join(" ")}, got: ${text.slice(0, 500)}`);
  }
}

function findString(value, predicate) {
  if (typeof value === "string" && predicate(value)) return value;
  if (!value || typeof value !== "object") return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, predicate);
      if (found) return found;
    }
    return "";
  }

  for (const key of ["name", "keyString", "response", "result"]) {
    if (key in value) {
      const found = findString(value[key], predicate);
      if (found) return found;
    }
  }

  for (const item of Object.values(value)) {
    const found = findString(item, predicate);
    if (found) return found;
  }

  return "";
}

function requireActiveAuth(opts) {
  const account = runGcloud(opts, [
    "auth",
    "list",
    "--filter=status:ACTIVE",
    "--format=value(account)",
  ]).trim();

  if (!account) {
    throw new Error(
      "No active gcloud account. Run: gcloud auth login --no-launch-browser",
    );
  }

  console.log(`[gcloud] active account: ${account}`);
}

function resolveProject(opts) {
  if (opts.project) return opts.project;

  const configured = runGcloud(opts, [
    "config",
    "get-value",
    "project",
    "--quiet",
  ]).trim();

  if (!configured || configured === "(unset)") {
    throw new Error("No Google Cloud project configured. Pass --project <project-id>.");
  }

  return configured;
}

function makeDisplayName(prefix, bot, slot) {
  return `${prefix}-${bot}-gemini-${slot}`;
}

function createApiKey(opts, project, displayName) {
  const created = runGcloud(opts, [
    "services",
    "api-keys",
    "create",
    `--display-name=${displayName}`,
    "--api-target=service=generativelanguage.googleapis.com",
    `--project=${project}`,
    "--format=json",
    "--quiet",
  ], { json: true, secret: true });

  const keyName = findString(created, (value) =>
    /^projects\/[^/]+\/locations\/[^/]+\/keys\/[^/]+$/.test(value)
  );
  const inlineKeyString = findString(created, (value) => /^AIza[0-9A-Za-z_-]+$/.test(value));

  if (inlineKeyString) return inlineKeyString;
  if (!keyName) {
    throw new Error(`Could not find API key resource name after creating ${displayName}`);
  }

  const keyResponse = runGcloud(opts, [
    "services",
    "api-keys",
    "get-key-string",
    keyName,
    `--project=${project}`,
    "--format=json",
    "--quiet",
  ], { json: true, secret: true });

  const keyString = findString(keyResponse, (value) => /^AIza[0-9A-Za-z_-]+$/.test(value));
  if (!keyString) {
    throw new Error(`Could not retrieve API key string for ${displayName}`);
  }

  return keyString;
}

function updateEnvFile(filePath, values) {
  const original = readFileSync(filePath, "utf8");
  const ending = original.endsWith("\n") ? "\n" : "";
  const lines = original.replace(/\n$/, "").split("\n");
  const remaining = new Map(values);

  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) return line;

    const key = match[1];
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining.entries()) {
    updated.push(`${key}=${value}`);
  }

  writeFileSync(filePath, `${updated.join("\n")}${ending}`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function botKeyValues(keys) {
  return new Map(keys.map((key, index) => [GEMINI_ENV_KEYS[index], key]));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.gcloud = findGcloud(opts.gcloud);

  const plan = Object.keys(BOT_ENV_FILES).flatMap((bot) =>
    Array.from({ length: opts.botKeys }, (_, i) => ({
      bot,
      slot: i + 1,
      displayName: makeDisplayName(opts.keyPrefix, bot, i + 1),
    }))
  );

  if (opts.dryRun) {
    console.log(`[dry-run] gcloud: ${opts.gcloud}`);
    console.log(`[dry-run] CLOUDSDK_CONFIG: ${opts.cloudConfig}`);
    for (const item of plan) console.log(`[dry-run] would create ${item.displayName}`);
    return;
  }

  requireActiveAuth(opts);
  const project = resolveProject(opts);
  console.log(`[gcloud] project: ${project}`);

  if (opts.enableServices) {
    console.log(`[gcloud] enabling required APIs: ${SERVICES.join(", ")}`);
    runGcloud(opts, ["services", "enable", ...SERVICES, `--project=${project}`, "--quiet"]);
  }

  const keysByBot = new Map(Object.keys(BOT_ENV_FILES).map((bot) => [bot, []]));
  for (const item of plan) {
    console.log(`[gcloud] creating restricted key ${item.displayName}`);
    const key = createApiKey(opts, project, item.displayName);
    keysByBot.get(item.bot).push(key);
  }

  for (const [bot, keys] of keysByBot.entries()) {
    updateEnvFile(BOT_ENV_FILES[bot], botKeyValues(keys));
    console.log(`[env] wrote ${keys.length} Gemini keys to packages/${bot}/.env`);
  }

  console.log("[done] Created keys are API-restricted to generativelanguage.googleapis.com.");
  console.log("[done] Key values were not printed. Restart the bot services to load them.");
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});
