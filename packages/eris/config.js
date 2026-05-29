// ─── packages/eris/config.js ────────────────────────────────────────────
// Single source of truth for env, model IDs, API keys, personality text,
// and tunables. Loaded synchronously at process start before anything else.
// See docs/start-here.md and section TOC below.
// ─── Centralized Configuration ──────────────────────────────────────────────
//
// ─── TABLE OF CONTENTS ──────────────────────────────────────────────────────
//  1. Imports & .env loader ............................. ~line 17
//  2. env() helper ..................................... ~line 41
//  3. Identity, twin API, agent kill switches ........... ~line 61
//  4. AI provider config (Gemini + NVIDIA fallback) ..... ~line 81
//  5. External integrations (Supabase, GH, music APIs) .. ~line 126
//  6. Bot personality (prompts/*.md + inline fallback) .. ~line 150
//  7. Tunables, colors, timeouts ........................ ~line 402
//  8. Startup validation & default export ............... ~line 434
// ────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTS & .ENV FILE LOADER — parses .env into envVars before anything else
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");
const envVars = {};

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const match = line.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    envVars[match[1]] = value;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// env() HELPER - deployed process.env values win over local .env defaults.
// ═══════════════════════════════════════════════════════════════════════════
function env(key, fallback) {
  return process.env[key] || envVars[key] || fallback;
}

const ghToken = env("GITHUB_TOKEN");

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

function parseJsonEnv(key, fallback = {}) {
  const value = env(key);
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    console.warn(`[WARN] ${key} must be valid JSON object syntax; ignoring it`);
    return fallback;
  }
}

function parseToolChoice(value, fallback = "auto") {
  if (!value) return fallback;
  if (["auto", "none", "required"].includes(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

const openAICompatibleProviderAliases = new Set([
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

const localOpenAICompatibleProviderAliases = new Set(["lmstudio", "ollama"]);

function getOpenAICompatDefaults(provider) {
  switch ((provider || "").toLowerCase()) {
    case "openrouter":
      return { providerName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" };
    case "groq":
      return { providerName: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" };
    case "cerebras":
      return { providerName: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "llama3.1-8b" };
    case "mistral":
      return { providerName: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" };
    case "deepinfra":
      return { providerName: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", model: "meta-llama/Meta-Llama-3.1-70B-Instruct" };
    case "together":
      return { providerName: "Together", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" };
    case "github":
      return { providerName: "GitHub Models", baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4o-mini" };
    case "cloudflare":
      return { providerName: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", model: "@cf/meta/llama-3.1-8b-instruct" };
    case "lmstudio":
      return { providerName: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "local-model" };
    case "ollama":
      return { providerName: "Ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" };
    case "openai":
      return { providerName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
    default:
      return { providerName: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
  }
}

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

function getOpenAICompatKeyListVars(provider) {
  switch ((provider || "").toLowerCase()) {
    case "openrouter":
      return ["OPENAI_COMPAT_API_KEYS", "OPENROUTER_API_KEYS"];
    default:
      return ["OPENAI_COMPAT_API_KEYS"];
  }
}

const selectedAIProvider = env("AI_PROVIDER", "gemini").toLowerCase();
const openAICompatDefaultConfig = getOpenAICompatDefaults(selectedAIProvider);
const openAICompatApiKey = envFirst(getOpenAICompatKeyVars(selectedAIProvider));
const openAICompatApiKeys = unique([
  openAICompatApiKey,
  ...envList(getOpenAICompatKeyListVars(selectedAIProvider)),
]);
const KIMI_K26_MODEL = "moonshotai/kimi-k2.6";
const selectedKimiOnNvidia = selectedAIProvider === "kimi";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG OBJECT — every runtime knob lives on this single object. Sections
// inside follow: identity → AI → integrations → personality → tunables.
// ═══════════════════════════════════════════════════════════════════════════
const config = {
  // ═══════════════════════════════════════════════════════════════════════════
  // IDENTITY, TWIN API, AGENT KILL SWITCHES — Discord credentials, owner ID,
  // bot name, PC agent disable flag, and the HMAC-signed twin (Irene) link.
  // ═══════════════════════════════════════════════════════════════════════════
  token: env("DISCORD_TOKEN"),
  clientId: env("CLIENT_ID"),
  ownerId: env("BOT_OWNER_ID"),
  port: parseInt(env("PORT", "3000")),

  // Identifier used for personality / longmemory / audit rows in Supabase.
  // Must be stable across restarts — changing it creates a fresh personality.
  botName: env("BOT_NAME", "eris"),

  // PC agent hardening. Set PC_AGENT_DISABLED=1 as a kill switch for all
  // owner-only machine-level tools (terminal, local exec, file browsing, launch_app).
  pcAgentDisabled: env("PC_AGENT_DISABLED", "0") === "1",
  // Twin API. HMAC-signed request protocol — see utils/twinSign.js.
  twinApiSecret: env("TWIN_API_SECRET"),
  twinApiUrl: env("IRENE_API_URL"),
  twinBotId: env("TWIN_BOT_ID"),

  // ═══════════════════════════════════════════════════════════════════════════
  // AI PROVIDER CONFIG — Gemini (primary) and NVIDIA Llama (fallback). Voyage
  // handles embeddings for semantic memory. Switch via aiProvider string.
  // ═══════════════════════════════════════════════════════════════════════════
  // AI Provider — "gemini", "nvidia", or OpenAI-compatible aliases like
  // "openai", "openrouter", "groq", "mistral", "lmstudio", and "ollama".
  aiProvider: selectedAIProvider,

  // Voyage AI (embeddings for semantic memory search)
  voyageApiKey: env("VOYAGE_API_KEY"),

  // ─── NVIDIA AI (Kimi K2.6 / other NVIDIA-hosted chat models) ─────────────
  // API key is env-only now — the previous hardcoded fallback was a credential
  // leak risk (visible in git history even in private repos). Set
  // NVIDIA_API_KEY in .env to use this provider. AI_PROVIDER=kimi selects
  // Kimi K2.6 defaults; AI_PROVIDER=nvidia keeps the generic NVIDIA defaults.
  nvidia: {
    apiKey: env("NVIDIA_API_KEY"),
    baseUrl: env("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
    model: env("NVIDIA_MODEL", selectedKimiOnNvidia ? KIMI_K26_MODEL : "meta/llama-3.3-70b-instruct"),
    fastModel: env("NVIDIA_FAST_MODEL", env("NVIDIA_MODEL", selectedKimiOnNvidia ? KIMI_K26_MODEL : "meta/llama-3.3-70b-instruct")),
    maxTokens: parseInt(env("NVIDIA_MAX_TOKENS", selectedKimiOnNvidia ? "16384" : "4096")),
    temperature: parseFloat(env("NVIDIA_TEMPERATURE", selectedKimiOnNvidia ? "1.0" : "0.4")),
    topP: parseFloat(env("NVIDIA_TOP_P", selectedKimiOnNvidia ? "1.0" : "0.95")),
    // Kimi K2.6 exposes reasoning through chat_template_kwargs.thinking.
    // Other NVIDIA models keep thinking off unless explicitly enabled.
    thinking: env("NVIDIA_THINKING", selectedKimiOnNvidia ? "true" : "false") === "true",
    // Kimi is strong enough to use judgment around tool calls. Keep older
    // NVIDIA models stricter unless explicitly relaxed.
    toolStrictness: env("NVIDIA_TOOL_STRICTNESS", selectedKimiOnNvidia ? "balanced" : "strict"),
  },

  // Generic OpenAI-compatible chat completions provider.
  openaiCompat: {
    apiKey: openAICompatApiKey || openAICompatApiKeys[0] || "",
    apiKeys: openAICompatApiKeys,
    baseUrl: env("OPENAI_COMPAT_BASE_URL", openAICompatDefaultConfig.baseUrl),
    model: env("OPENAI_COMPAT_MODEL", openAICompatDefaultConfig.model),
    fastModel: env("OPENAI_COMPAT_FAST_MODEL", env("OPENAI_COMPAT_MODEL", openAICompatDefaultConfig.model)),
    chatModel: env("OPENAI_COMPAT_CHAT_MODEL", env("OPENAI_COMPAT_MODEL", openAICompatDefaultConfig.model)),
    maxTokens: parseInt(env("OPENAI_COMPAT_MAX_TOKENS", "4096")),
    temperature: parseFloat(env("OPENAI_COMPAT_TEMPERATURE", "0.4")),
    topP: parseFloat(env("OPENAI_COMPAT_TOP_P", "0.95")),
    providerName: env("OPENAI_COMPAT_PROVIDER_NAME", openAICompatDefaultConfig.providerName),
    httpReferer: env("OPENAI_COMPAT_HTTP_REFERER"),
    appTitle: env("OPENAI_COMPAT_APP_TITLE", "Eris"),
    extraHeaders: parseJsonEnv("OPENAI_COMPAT_EXTRA_HEADERS"),
    toolChoice: parseToolChoice(env("OPENAI_COMPAT_TOOL_CHOICE"), "auto"),
    allowNoApiKey: localOpenAICompatibleProviderAliases.has(selectedAIProvider) || env("OPENAI_COMPAT_ALLOW_NO_API_KEY", "0") === "1",
  },

  // Gemini API (legacy — kept as fallback provider)
  geminiKeys: [
    env("GEMINI_API_KEY"),
    env("GEMINI_API_KEY_2"),
    env("GEMINI_API_KEY_3"),
    env("GEMINI_API_KEY_4"),
  ].filter(Boolean),

  geminiModel: env("GEMINI_MODEL", "gemini-3.1-pro-preview"),
  geminiFallbackModel: env("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash"),
  geminiFastModel: env("GEMINI_FAST_MODEL", "gemini-3-flash-preview"),

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTERNAL INTEGRATIONS — Supabase persistence, music (Last.fm), GIFs (Klipy),
  // GitHub (gh-derived token), Render deploys, Google OAuth (Gmail/etc.).
  // ═══════════════════════════════════════════════════════════════════════════
  supabaseUrl: env("SUPABASE_URL"),
  supabaseKey: env("SUPABASE_KEY"),
  requirePersistence: env("REQUIRE_PERSISTENCE", "0") === "1",
  get supabaseEnabled() {
    return !!(this.supabaseUrl && this.supabaseKey && !this.supabaseUrl.includes("your-"));
  },

  lastfmApiKey: env("LASTFM_API_KEY"),
  klipyApiKey: env("KLIPY_API_KEY"),
  githubToken: ghToken,
  // Repo allowlist for GitHub write operations (github_create_issue, etc.).
  // Comma/whitespace-separated list of "owner/repo" entries. Required defense
  // for the broad-scope shared PAT — owner-gate alone is not sufficient. If
  // unset, write ops are refused with a clear error.
  githubRepoAllowlist: envList(["GITHUB_REPO_ALLOWLIST"])
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.includes("/")),
  renderApiKey: env("RENDER_API_KEY"),
  dreamChannelId: env("DREAM_CHANNEL_ID"),
  briefingChannelId: env("BRIEFING_CHANNEL_ID"),

  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    get enabled() { return !!(this.clientId && this.clientSecret && this.refreshToken); },
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

  // ═══════════════════════════════════════════════════════════════════════════
  // BOT PERSONALITY — assembled from prompts/*.md at startup.
  // ═══════════════════════════════════════════════════════════════════════════
  // To edit personality, modify files in prompts/ directory.
  botPersonality: (() => {
    const promptDir = join(__dirname, "prompts");
    const load = (name) => readFileSync(join(promptDir, `${name}.md`), "utf8");
    const ownerId = env("BOT_OWNER_ID");
    const twinBotId = env("TWIN_BOT_ID");
    // Tool guide is omitted — each tool has its own description in the schema
    // which Gemini already sees. Including a 10k tool guide in the system
    // prompt was redundant and doubled the input token count.
    return [
      load("eris-personality"),
      load("eris-relationships").replace(/\{\{OWNER_ID\}\}/g, ownerId ?? "").replace(/\{\{TWIN_BOT_ID\}\}/g, twinBotId ?? ""),
      load("eris-rules"),
    ].join("\n\n");
  })(),

  // ═══════════════════════════════════════════════════════════════════════════
  // TUNABLES, COLORS, TIMEOUTS — runtime knobs (cooldowns, history budgets),
  // embed colors, and request timeouts overridable via TIMEOUT_* env vars.
  // ═══════════════════════════════════════════════════════════════════════════
  // Tunables
  aiCooldownMs: 1500,
  aiMaxHistory: 10,
  maxQueuedMessages: 3,
  historyCharBudget: 8000,
  toolResultMaxChars: 500,
  webRateLimitPerMin: 10,

  colors: {
    primary:    0x9333EA,  // purple — Eris's color
    gif:        0x2b2d31,  // near-black — blends with dark theme
    meme:       0x2b2d31,  // near-black for meme embeds
    success:    0x10B981,
    error:      0xEF4444,
    warning:    0xF59E0B,
    info:       0x6366F1,
    muted:      0x6B7280,
  },

  // ─── Timeouts ────────────────────────────────────────────────────────────
  // Override any of these via env vars like TIMEOUT_WORKER=45000.
  timeouts: {
    quickReply: parseInt(env("TIMEOUT_QUICK_REPLY", "15000")),
    // Per-call budget for slow tools (web_search/scrape_url grounding, image
    // lookup, GitHub, etc.). Raised from the old hardcoded 25s so Gemini Search
    // grounding has room to finish instead of being aborted mid-flight.
    slowTool:   parseInt(env("TIMEOUT_SLOW_TOOL", "30000")),
    // runGeminiChat outer timeout, split by model path: the fast (conversational)
    // path is snappier, the worker (tool/thinking) path needs headroom for at
    // least one slow tool (web_search, scrape_url) plus a follow-up call.
    workerFast: parseInt(env("TIMEOUT_WORKER_FAST", "45000")),
    workerSlow: parseInt(env("TIMEOUT_WORKER_SLOW", "90000")),
    // Generic worker timeout still consumed by the NVIDIA / OpenAI-compat
    // providers (which don't split fast/slow). Kept for backward compat.
    worker:     parseInt(env("TIMEOUT_WORKER", "60000")),
    fetch:      parseInt(env("TIMEOUT_FETCH", "5000")),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP VALIDATION & DEFAULT EXPORT — fail-fast checks for required env
// vars; non-fatal warnings for optional integrations; module export.
// ═══════════════════════════════════════════════════════════════════════════
// ─── Startup validation — fail fast on missing critical vars ────────────────
if (!config.token) {
  console.error("[FATAL] DISCORD_TOKEN is required in .env");
  process.exit(1);
}
if (!config.clientId) {
  console.error("[FATAL] CLIENT_ID is required in .env (needed for slash command registration)");
  process.exit(1);
}
const configuredAIProvider = (config.aiProvider || "").toLowerCase();
if ((configuredAIProvider === "gemini" || configuredAIProvider === "google") && !config.geminiKeys.length) {
  console.error("[FATAL] At least one GEMINI_API_KEY is required when AI_PROVIDER=gemini");
  process.exit(1);
}
if ((configuredAIProvider === "nvidia" || configuredAIProvider === "kimi") && !config.nvidia.apiKey) {
  console.error("[FATAL] NVIDIA_API_KEY is required when AI_PROVIDER=nvidia/kimi");
  process.exit(1);
}
if (
  openAICompatibleProviderAliases.has(configuredAIProvider)
  && !config.openaiCompat.allowNoApiKey
  && !config.openaiCompat.apiKeys.length
) {
  console.error(`[FATAL] OPENAI_COMPAT_API_KEY/OPENAI_COMPAT_API_KEYS or the provider-specific API key env is required when AI_PROVIDER=${config.aiProvider}`);
  process.exit(1);
}
if (!["gemini", "google", "nvidia", "kimi"].includes(configuredAIProvider) && !openAICompatibleProviderAliases.has(configuredAIProvider)) {
  console.error(`[FATAL] AI_PROVIDER="${config.aiProvider}" is not a recognized value. Expected "gemini", "nvidia", or an OpenAI-compatible alias.`);
  process.exit(1);
}
// Non-fatal warnings for degraded functionality
if (!config.supabaseEnabled) {
  console.warn("[WARN] SUPABASE_URL / SUPABASE_KEY missing or invalid — running without persistence. Coins, memories, settings will NOT be saved.");
}
if (!config.lastfmApiKey) {
  console.warn("[WARN] LASTFM_API_KEY missing — /fm commands will not work");
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
