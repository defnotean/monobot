// ─── packages/irene/config.js ───────────────────────────────────────────
// Single source of truth for env / model IDs / API keys / Lavalink /
// timeouts. Loaded synchronously before everything. Fail-fast on missing
// required keys; warn-and-continue on optional ones.
// See docs/start-here.md and the existing TOC below.

// ─── Centralized Configuration ──────────────────────────────────────────────
//
// ─── TABLE OF CONTENTS ──────────────────────────────────────────────────────
//  1. Imports & .env loader ............... ~line 17
//  2. env() helper ........................ ~line 48
//  3. Discord identity & Twin API ......... ~line 56
//  4. Lavalink (music) .................... ~line 76
//  5. AI providers (NVIDIA + Gemini keys) . ~line 82
//  6. External APIs (Supabase, Twitch) .... ~line 115
//  7. Bot personality (prompt loader) ..... ~line 121
//  8. Rate limits & misc tunables ......... ~line 234
//  9. Embed colors palette ................ ~line 260
// 10. Timeouts ............................ ~line 275
// 11. Validation & export ................. ~line 290
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ═══════════════════════════════════════════════════════════════════════════
// .ENV LOADER — manual parser, avoids system env conflicts
// ═══════════════════════════════════════════════════════════════════════════

// Read .env file manually to avoid system env conflicts
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");
const envVars = {};

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    // Skip comments and empty lines
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const match = line.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    envVars[match[1]] = value;
  }
}

// Deployed process.env values win over local .env defaults.
function env(key, fallback) {
  return process.env[key] || envVars[key] || fallback;
}

function envJson(key, fallback = {}) {
  const raw = env(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function envToolChoice(key, fallback = "auto") {
  const raw = env(key);
  if (!raw) return fallback;
  if (raw === "none" || raw === "auto" || raw === "required") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function envFirst(keys, fallback = "") {
  for (const key of keys) {
    const value = env(key);
    if (value) return value;
  }
  return fallback;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function envList(keys) {
  const values = [];
  for (const key of keys) {
    const raw = env(key);
    if (!raw) continue;
    values.push(...raw.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean));
  }
  return unique(values);
}

const OPENAI_COMPAT_PROVIDERS = new Set([
  "openai-compatible",
  "openaicompatible",
  "openai_compatible",
  "openai-compat",
  "openai",
  "openrouter",
  "groq",
  "cerebras",
  "mistral",
  "deepinfra",
  "together",
  "github",
  "cloudflare",
  "lmstudio",
  "ollama",
]);

const OPENAI_COMPAT_DEFAULTS = {
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", fastModel: "gpt-4o-mini" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", fastModel: "gpt-4o-mini" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", fastModel: "openai/gpt-4o-mini" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", fastModel: "llama-3.1-8b-instant" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", model: "llama3.1-70b", fastModel: "llama3.1-8b" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest", fastModel: "mistral-small-latest" },
  deepinfra: { baseUrl: "https://api.deepinfra.com/v1/openai", model: "meta-llama/Llama-3.3-70B-Instruct", fastModel: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
  together: { baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", fastModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" },
  github: { baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4o-mini", fastModel: "openai/gpt-4o-mini" },
  cloudflare: { baseUrl: "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1", model: "@cf/meta/llama-3.1-8b-instruct", fastModel: "@cf/meta/llama-3.1-8b-instruct" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "local-model", fastModel: "local-model" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", fastModel: "llama3.1" },
};

const selectedAiProvider = env("AI_PROVIDER", "gemini").toLowerCase();
const openaiCompatDefaults = OPENAI_COMPAT_DEFAULTS[selectedAiProvider] || OPENAI_COMPAT_DEFAULTS["openai-compatible"];

function getOpenAICompatKeyVars(provider) {
  switch ((provider || "").toLowerCase()) {
    case "openai":
    case "openai-compatible":
    case "openaicompatible":
    case "openai_compatible":
    case "openai-compat":
      return ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY"];
    case "openrouter":
      return ["OPENAI_COMPAT_API_KEY", "OPENROUTER_API_KEY"];
    case "groq":
      return ["OPENAI_COMPAT_API_KEY", "GROQ_API_KEY"];
    case "cerebras":
      return ["OPENAI_COMPAT_API_KEY", "CEREBRAS_API_KEY"];
    case "mistral":
      return ["OPENAI_COMPAT_API_KEY", "MISTRAL_API_KEY"];
    case "deepinfra":
      return ["OPENAI_COMPAT_API_KEY", "DEEPINFRA_API_KEY"];
    case "together":
      return ["OPENAI_COMPAT_API_KEY", "TOGETHER_API_KEY"];
    case "github":
      return ["OPENAI_COMPAT_API_KEY", "GITHUB_MODELS_API_KEY", "GITHUB_TOKEN"];
    case "cloudflare":
      return ["OPENAI_COMPAT_API_KEY", "CLOUDFLARE_API_TOKEN"];
    default:
      return ["OPENAI_COMPAT_API_KEY"];
  }
}

// ─── Lavalink password policy ───────────────────────────────────────────────
// Lavalink ships with the literal password "youshallnotpass" — leaving it as
// the default is identical to no auth, because every default Lavalink install
// on the internet uses the same string. We refuse to enable music if a
// self-hoster exposes the node off-host with that default; localhost gets a
// softer warning since the port isn't routable from outside the box.
// Pure function (no env access) so tests can drive it with explicit inputs.
const LAVALINK_DEFAULT_PASSWORD = "youshallnotpass";
const LAVALINK_LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

export function evaluateLavalinkConfig({ host, password }) {
  const trimmedHost = (host ?? "").trim().toLowerCase();
  const isLocalhost = LAVALINK_LOCALHOST_HOSTS.has(trimmedHost);
  const hasPassword = typeof password === "string" && password.length > 0;
  const isDefaultPassword = password === LAVALINK_DEFAULT_PASSWORD;

  if (!hasPassword) {
    if (isLocalhost) {
      return {
        enabled: true,
        warning:
          "LAVALINK_PASSWORD is unset — falling back to Lavalink's default password for localhost only. Set LAVALINK_PASSWORD to a strong value before exposing the port.",
        fatal: null,
        effectivePassword: LAVALINK_DEFAULT_PASSWORD,
        isDefaultPassword: true,
        isLocalhost: true,
      };
    }
    return {
      enabled: false,
      warning: null,
      fatal: `LAVALINK_PASSWORD is unset and LAVALINK_HOST="${host}" is not localhost. Refusing to enable music features. Set LAVALINK_PASSWORD to a strong value (e.g. \`openssl rand -hex 32\`) before exposing the port.`,
      effectivePassword: "",
      isDefaultPassword: true,
      isLocalhost: false,
    };
  }

  if (isDefaultPassword) {
    if (isLocalhost) {
      return {
        enabled: true,
        warning:
          'LAVALINK_PASSWORD is the Lavalink default ("youshallnotpass"). This is only safe because LAVALINK_HOST is localhost. Change it before exposing the port off-host.',
        fatal: null,
        effectivePassword: password,
        isDefaultPassword: true,
        isLocalhost: true,
      };
    }
    return {
      enabled: false,
      warning: null,
      fatal: `LAVALINK_PASSWORD is the Lavalink default password ("youshallnotpass"), which is a well-known string shared by every default Lavalink install. LAVALINK_HOST="${host}" is not localhost, so the node is effectively unauthenticated. Refusing to enable music features. Set LAVALINK_PASSWORD to a strong value (e.g. \`openssl rand -hex 32\`) before exposing the port.`,
      effectivePassword: password,
      isDefaultPassword: true,
      isLocalhost: false,
    };
  }

  return {
    enabled: true,
    warning: null,
    fatal: null,
    effectivePassword: password,
    isDefaultPassword: false,
    isLocalhost,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG OBJECT — Discord identity, Twin API, music, AI providers, personality
// ═══════════════════════════════════════════════════════════════════════════

function getOpenAICompatKeyListVars(provider) {
  switch ((provider || "").toLowerCase()) {
    case "openrouter":
      return ["OPENAI_COMPAT_API_KEYS", "OPENROUTER_API_KEYS"];
    default:
      return ["OPENAI_COMPAT_API_KEYS"];
  }
}

const openaiCompatApiKey = envFirst(getOpenAICompatKeyVars(selectedAiProvider));
const openaiCompatApiKeys = unique([
  ...envList(getOpenAICompatKeyListVars(selectedAiProvider)),
  openaiCompatApiKey,
]);
const KIMI_K26_MODEL = "moonshotai/kimi-k2.6";
const selectedKimiOnNvidia = selectedAiProvider === "kimi";

const config = {
  token: env("DISCORD_BOT_TOKEN"),
  clientId: env("DISCORD_CLIENT_ID"),
  ownerId: env("DISCORD_USER_ID"),
  port: parseInt(env("PORT", "3001")),

  // Identifier used for personality / longmemory / audit rows in Supabase.
  // Must be stable across restarts — changing it creates a fresh personality.
  botName: env("BOT_NAME", "irene"),

  // Twin API. HMAC-signed for /api/twin/command, Bearer-gated for
  // /api/twin/state. Both use the same TWIN_API_SECRET.
  twinApiSecret: env("TWIN_API_SECRET"),
  twinApiUrl: env("ERIS_API_URL"),
  twinBotId: env("ERIS_BOT_ID"),
  lavalink: (() => {
    const host = env("LAVALINK_HOST", "localhost");
    const port = parseInt(env("LAVALINK_PORT", "2333"));
    // No fallback to the well-known default — see evaluateLavalinkConfig().
    const password = env("LAVALINK_PASSWORD", "");
    const secure = env("LAVALINK_SECURE", "false") === "true";
    const verdict = evaluateLavalinkConfig({ host, password });
    // Loud refusal on default-password + non-localhost. Music stays off,
    // bot keeps booting so non-music features remain usable.
    if (verdict.fatal) console.error(`[LAVALINK] ${verdict.fatal}`);
    else if (verdict.warning) console.warn(`[LAVALINK] ${verdict.warning}`);
    return {
      host,
      port,
      password: verdict.effectivePassword,
      secure,
      enabled: verdict.enabled,
    };
  })(),
  // ─── AI Provider — Irene runs on Gemini (Eris runs on NVIDIA Kimi) ────────
  // The bot's "brain" plugs into ai/providers/<name>.js. To switch, set
  // AI_PROVIDER in .env: "gemini" → Google Gemini | "nvidia" → Kimi K2.5
  aiProvider: selectedAiProvider,

  // ─── NVIDIA AI (Qwen 3.5 122B A10B — MoE with strong tool calling) ────────
  nvidia: {
    apiKey: env("NVIDIA_API_KEY"),
    baseUrl: env("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
    model: env("NVIDIA_MODEL", selectedKimiOnNvidia ? KIMI_K26_MODEL : "meta/llama-3.3-70b-instruct"),
    fastModel: env("NVIDIA_FAST_MODEL", env("NVIDIA_MODEL", selectedKimiOnNvidia ? KIMI_K26_MODEL : "meta/llama-3.3-70b-instruct")),
    maxTokens: parseInt(env("NVIDIA_MAX_TOKENS", selectedKimiOnNvidia ? "16384" : "4096")),
    temperature: parseFloat(env("NVIDIA_TEMPERATURE", selectedKimiOnNvidia ? "1.0" : "0.4")),
    topP: parseFloat(env("NVIDIA_TOP_P", selectedKimiOnNvidia ? "1.0" : "0.95")),
    thinking: env("NVIDIA_THINKING", selectedKimiOnNvidia ? "true" : "false") === "true",
    toolStrictness: env("NVIDIA_TOOL_STRICTNESS", selectedKimiOnNvidia ? "balanced" : "strict"),
  },

  // Generic OpenAI-compatible chat completions provider.
  // Enabled by AI_PROVIDER=openai-compatible/openai/openrouter/groq/cerebras/
  // mistral/deepinfra/together/github/cloudflare/lmstudio/ollama.
  openaiCompat: {
    apiKey: openaiCompatApiKey || openaiCompatApiKeys[0] || "",
    apiKeys: openaiCompatApiKeys,
    baseUrl: env("OPENAI_COMPAT_BASE_URL", openaiCompatDefaults.baseUrl),
    model: env("OPENAI_COMPAT_MODEL", openaiCompatDefaults.model),
    fastModel: env("OPENAI_COMPAT_FAST_MODEL", openaiCompatDefaults.fastModel),
    chatModel: env("OPENAI_COMPAT_CHAT_MODEL", env("OPENAI_COMPAT_MODEL", openaiCompatDefaults.model)),
    maxTokens: parseInt(env("OPENAI_COMPAT_MAX_TOKENS", "4096")),
    temperature: parseFloat(env("OPENAI_COMPAT_TEMPERATURE", "0.4")),
    topP: parseFloat(env("OPENAI_COMPAT_TOP_P", "0.95")),
    providerName: env("OPENAI_COMPAT_PROVIDER_NAME", selectedAiProvider),
    httpReferer: env("OPENAI_COMPAT_HTTP_REFERER", ""),
    appTitle: env("OPENAI_COMPAT_APP_TITLE", ""),
    extraHeaders: envJson("OPENAI_COMPAT_EXTRA_HEADERS", {}),
    toolChoice: envToolChoice("OPENAI_COMPAT_TOOL_CHOICE", "auto"),
    allowNoApiKey: ["lmstudio", "ollama"].includes(selectedAiProvider) || env("OPENAI_COMPAT_ALLOW_NO_API_KEY", "0") === "1",
  },

  // Gemini (legacy — still works if AI_PROVIDER=gemini)
  geminiKeys: [
    env("GEMINI_API_KEY"),
    env("GEMINI_API_KEY_2"),
    env("GEMINI_API_KEY_3"),
    env("GEMINI_API_KEY_4"),
    env("GEMINI_API_KEY_5"),
    env("GEMINI_API_KEY_6"),
    env("GEMINI_API_KEY_7"),
    env("GEMINI_API_KEY_8"),
    env("GEMINI_API_KEY_9"),
    env("GEMINI_API_KEY_10"),
    env("GEMINI_API_KEY_11"),
    env("GEMINI_API_KEY_12"),
  ].filter(Boolean),

  // ═══════════════════════════════════════════════════════════════════════
  // EXTERNAL APIs — Supabase (persistence) + Twitch (live stream notifications)
  // ═══════════════════════════════════════════════════════════════════════
  supabaseUrl: env("SUPABASE_URL"),
  supabaseKey: env("SUPABASE_KEY"),
  supabaseAnonKey: env("SUPABASE_ANON_KEY"),
  requirePersistence: env("REQUIRE_PERSISTENCE", "0") === "1",
  get supabaseEnabled() {
    return !!(this.supabaseUrl && this.supabaseKey && !this.supabaseUrl.includes("your-"));
  },

  webSearch: {
    searxngQueryUrl: env("SEARXNG_QUERY_URL"),
    tavilyApiKey: env("TAVILY_API_KEY"),
    braveSearchApiKey: env("BRAVE_SEARCH_API_KEY"),
    braveAnswersApiKey: env("BRAVE_ANSWERS_API_KEY", env("BRAVE_SEARCH_API_KEY")),
    braveAnswersModel: env("BRAVE_ANSWERS_MODEL", "brave"),
    braveAnswersTimeoutMs: parseInt(env("BRAVE_ANSWERS_TIMEOUT_MS", "5000")),
    braveSearchTimeoutMs: parseInt(env("BRAVE_SEARCH_TIMEOUT_MS", "3500")),
    backendTimeoutMs: parseInt(env("WEB_SEARCH_BACKEND_TIMEOUT_MS", "5000")),
    ddgTimeoutMs: parseInt(env("WEB_SEARCH_DDG_TIMEOUT_MS", "5000")),
    serperApiKey: env("SERPER_API_KEY"),
    googleSearchKey: env("GOOGLE_SEARCH_KEY"),
    googleSearchCx: env("GOOGLE_SEARCH_CX"),
  },

  twitchClientId: env("TWITCH_CLIENT_ID"),
  twitchClientSecret: env("TWITCH_CLIENT_SECRET"),

  // ─── Dual-write persistence (Phase 1 of database refactor) ────────────────
  // When true, every write goes to BOTH the legacy single-row blob (bot_data)
  // AND the new per-entity tables in packages/irene/database/perEntity.js.
  // OFF by default — flip to true to validate the new layer in production
  // before later PRs migrate read paths over and drop the old blob.
  dualWritePersistence: env("DUAL_WRITE_PERSISTENCE", "false") === "true",

  // ═══════════════════════════════════════════════════════════════════════
  // BOT PERSONALITY — loaded from prompts/*.md, with hard-coded fallback
  // ═══════════════════════════════════════════════════════════════════════
  // Bot personality — loaded from prompts/*.md files at runtime.
  // To edit personality, modify files in prompts/ directory.
  botPersonality: (() => {
    const promptDir = join(__dirname, "prompts");
    const ownerId = env("DISCORD_USER_ID");
    const twinBotId = env("ERIS_BOT_ID");
    return readFileSync(join(promptDir, "irene-personality.md"), "utf8").replace(/\{\{OWNER_ID\}\}/g, ownerId ?? "").replace(/\{\{TWIN_BOT_ID\}\}/g, twinBotId ?? "");
  })(),

  // ═══════════════════════════════════════════════════════════════════════
  // RATE LIMITS, EMBEDDINGS & TUNABLE THRESHOLDS
  // ═══════════════════════════════════════════════════════════════════════
  // Rate limits
  aiCooldownMs: 1500, // 1.5 seconds between AI requests per user
  aiMaxHistory: 10, // Messages to keep in conversation memory

  // Voyage AI (embeddings for semantic memory search)
  voyageApiKey: env("VOYAGE_API_KEY"),

  // Gemini model names
  geminiModel: env("GEMINI_MODEL", "gemini-3.1-pro-preview"),
  geminiFallbackModel: env("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash"),
  geminiFastModel: env("GEMINI_FAST_MODEL", "gemini-3-flash-preview"),
  // Multimodal image model for edit_image (input photo + prompt -> edited photo).
  // Default: Nano Banana 2; falls back to 2.5-flash-image / 3-pro-image-preview.
  geminiImageModel: env("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image-preview"),

  // Tunable thresholds
  maxQueuedMessages: 3,
  historyCharBudget: 8000,
  aiPromptCharBudget: parseInt(env("AI_PROMPT_CHAR_BUDGET", "100000")),
  toolResultMaxChars: 500,
  historyToolResultMax: 300,
  ttsMaxCacheSize: 50,
  webRateLimitPerMin: 10,

  // ═══════════════════════════════════════════════════════════════════════
  // EMBED COLORS — brand palette used across all embeds
  // ═══════════════════════════════════════════════════════════════════════
  // Colors for embeds
  colors: {
    primary:    0x7C3AED,  // violet — Irene's signature brand color
    success:    0x10B981,  // emerald green
    error:      0xEF4444,  // clean red
    warning:    0xF59E0B,  // amber
    info:       0x6366F1,  // indigo
    music:      0x1DB954,  // Spotify green
    moderation: 0xF97316,  // orange
    muted:      0x6B7280,  // neutral gray
  },

  // ─── Timeouts ────────────────────────────────────────────────────────────
  // Centralized so tuning doesn't require grepping across the codebase.
  // Values are in milliseconds. Override any of these via env vars like
  // TIMEOUT_TOOL_SLOW=45000.
  timeouts: {
    quickReply:    parseInt(env("TIMEOUT_QUICK_REPLY", "5000")),
    workerFast:    parseInt(env("TIMEOUT_WORKER_FAST", "35000")),
    workerSlow:    parseInt(env("TIMEOUT_WORKER_SLOW", "60000")),
    toolFast:      parseInt(env("TIMEOUT_TOOL_FAST", "15000")),
    toolSlow:      parseInt(env("TIMEOUT_TOOL_SLOW", "30000")),
    toolVerySlow:  parseInt(env("TIMEOUT_TOOL_VERY_SLOW", "60000")),
    fetch:         parseInt(env("TIMEOUT_FETCH", "5000")),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION & EXPORT — bail out at startup if Discord token is missing
// ═══════════════════════════════════════════════════════════════════════════

if (!config.token) {
  console.error("[FATAL] DISCORD_BOT_TOKEN is required in .env");
  process.exit(1);
}
if (!config.clientId) {
  console.error("[FATAL] DISCORD_CLIENT_ID is required in .env (needed for slash command registration)");
  process.exit(1);
}
// Validate matching API key for the chosen AI provider so a misconfig
// fails at startup, not at the first user message. Mirrors Eris's block.
if (config.aiProvider === "gemini" && !config.geminiKeys.length) {
  console.error("[FATAL] At least one GEMINI_API_KEY is required when AI_PROVIDER=gemini");
  process.exit(1);
}
if ((config.aiProvider === "nvidia" || config.aiProvider === "kimi") && !config.nvidia.apiKey) {
  console.error("[FATAL] NVIDIA_API_KEY is required when AI_PROVIDER=nvidia/kimi");
  process.exit(1);
}
if (OPENAI_COMPAT_PROVIDERS.has(config.aiProvider) && !config.openaiCompat.allowNoApiKey && !config.openaiCompat.apiKeys.length) {
  console.error(`[FATAL] OPENAI_COMPAT_API_KEY/OPENAI_COMPAT_API_KEYS (or provider-specific key env) is required when AI_PROVIDER=${config.aiProvider}`);
  process.exit(1);
}
if (!["gemini", "google", "nvidia", "kimi"].includes(config.aiProvider) && !OPENAI_COMPAT_PROVIDERS.has(config.aiProvider)) {
  console.error(`[FATAL] AI_PROVIDER="${config.aiProvider}" is not a recognized value. Expected "gemini", "nvidia", or an OpenAI-compatible alias.`);
  process.exit(1);
}
// Non-fatal warnings for degraded functionality
if (!config.supabaseEnabled) {
  console.warn("[WARN] SUPABASE_URL / SUPABASE_KEY missing or invalid — running without persistence. Most Irene features will not work.");
}

// Local-stack toggles for the 100%-local self-host path. All optional —
// existing cloud paths are unaffected when these are unset.
config.local = {
  stt: env("LOCAL_STT") === "1",
  tts: env("LOCAL_TTS") === "1",
  whisperBin: env("WHISPER_BIN", `${process.env.HOME || ""}/.local/whisper-cli`),
  piperBin: env("PIPER_BIN", `${process.env.HOME || ""}/.local/piper/piper/piper`),
  piperVoice: env("PIPER_VOICE", `${process.env.HOME || ""}/.local/piper/voice.onnx`),
  ollamaEmbedUrl: env("OLLAMA_EMBED_URL"),
  ollamaEmbedModel: env("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
  ollamaVisionUrl: env("OLLAMA_VISION_URL"),
  ollamaVisionModel: env("OLLAMA_VISION_MODEL", "llava:7b"),
};

export default config;
