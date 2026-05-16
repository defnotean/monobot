/**
 * @file logRedact.js
 * @module @defnotean/shared/logRedact
 *
 * @overview
 * Last-mile redactor for the file/console transports of the two bot loggers.
 * Every log line gets passed through `redactLogLine()` before it lands on
 * disk or stdout. The goal: even if a careless caller does
 * `log(\`oops: \${err}\`)` and that error happens to embed an auth header, a
 * Bearer token, a provider API key, or the bot token, the secret never makes
 * it to `bot.log`.
 *
 * The redactor is intentionally conservative — false positives (a redacted
 * non-secret) are strictly preferable to false negatives (a real secret
 * landing on disk forever).
 *
 * @section Key exports
 *   - `redactString(s)` — apply both pattern-based and env-value-based
 *     redaction to a single string. Returns the redacted string.
 *   - `redactValue(v, depth)` — recursively redact a value of any shape
 *     (string, object, array, Error, etc.). Returns a redacted clone.
 *   - `redactLogLine(s)` — redact a string AND truncate it to
 *     `MAX_LOG_LINE_BYTES`. The function loggers actually call.
 *   - `MAX_LOG_LINE_BYTES` — hard cap on per-line length. Default 8192.
 *
 * @section Detection strategy
 * 1. Known env-var values — anything currently present in `process.env` for
 *    a configured-secret key (DISCORD_TOKEN, GEMINI_API_KEY, etc.) is
 *    string-replaced first. This is the highest-confidence path.
 * 2. Token-shaped substrings — regex passes for common auth-prefix patterns
 *    (Bot, Bearer, MFA, Basic, sk-, gsk_, …) and bare high-entropy runs
 *    longer than a threshold. Catches secrets that aren't in env (e.g.
 *    upstream-error-body echoes of other tenants' keys).
 *
 * Replacements always emit a literal `[REDACTED]` so operators can grep for
 * "how often did the redactor fire" without ambiguity.
 *
 * @section Truncation
 * `MAX_LOG_LINE_BYTES` keeps a runaway stack dump or upstream-body echo from
 * filling the 5 MB log file in a single line. Truncated lines get an
 * `…[truncated N bytes]` suffix so a reader knows the cut happened.
 */

// 8 KB per line — long enough for a full stack trace, short enough that a
// single bad log call can't blow the file roll.
export const MAX_LOG_LINE_BYTES = 8192;

// Env keys whose VALUE should never appear in a log line. The redactor
// snapshots `process.env[name]` lazily on every call so it stays correct
// across hot-reloads / late env binding.
const SECRET_ENV_KEYS = [
  // Discord
  "DISCORD_TOKEN",
  "DISCORD_BOT_TOKEN",
  // AI providers
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_API_KEYS",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_KEYS",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPINFRA_API_KEY",
  "TOGETHER_API_KEY",
  "GITHUB_MODELS_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  // Embeddings / search
  "VOYAGE_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "BRAVE_ANSWERS_API_KEY",
  "TAVILY_API_KEY",
  "SERPER_API_KEY",
  "GOOGLE_SEARCH_KEY",
  // Persistence + infra
  "SUPABASE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RENDER_API_KEY",
  // External integrations
  "LASTFM_API_KEY",
  "KLIPY_API_KEY",
  "GITHUB_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  // Twin / dashboard auth
  "TWIN_API_SECRET",
  "DASHBOARD_API_KEY",
];

// Minimum length for an env-var value to be worth pattern-replacing. Anything
// shorter is either a placeholder ("test-dummy-token") or far too short to be
// a real secret, and trying to redact e.g. "0" matches every digit on disk.
const MIN_ENV_VALUE_LEN = 8;

// Regexes applied AFTER env-value substitution. Each one targets a common
// secret shape that may show up in upstream error bodies, stack traces, or
// careless caller-side string interpolation.
//
// Pattern philosophy: prefer over-matching. The cost of a `[REDACTED]` where
// a non-secret used to be is "operator squints once"; the cost of a missed
// secret is "secret on disk forever."
const TOKEN_PATTERNS = [
  // Pattern order matters — earlier patterns run first, and later ones see
  // text that already contains "[REDACTED]" placeholders, so we put the
  // most specific shapes (URL query, Authorization scheme) ahead of the
  // looser header-key form.

  // URL query-string secret params. Covers `?key=...`, `&api_key=...`,
  // `?token=...`, etc. Strips the value but keeps the param name for
  // triage. Anchored on the literal `=` so it can't compete with the
  // header `:` form below.
  { re: /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|auth|secret|password|pwd)=)[A-Za-z0-9._\-+/=%]{8,}/gi,
    fmt: (_m, prefix) => `${prefix}[REDACTED]` },

  // Authorization-header scheme + credential. Captures the scheme word so
  // operators still see WHICH auth type was used.
  { re: /\b(Bearer|Bot|MFA|Basic|ApiKey)\s+[A-Za-z0-9._\-+/=]{8,}/gi,
    fmt: (_m, scheme) => `${scheme} [REDACTED]` },

  // `Authorization:` / `X-API-Key:` / `api-key:` header VALUES — only the
  // `:` (header) form, not `=` (handled by URL pattern above). Quoted or
  // unquoted, single or double quotes.
  { re: /\b(Authorization|X-API-Key|Api-Key|X-Auth-Token|api[_-]?key)\b\s*:\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
    fmt: (_m, k) => `${k}: [REDACTED]` },

  // Provider-prefixed keys. OpenAI / Anthropic / Groq / etc. all ship with
  // distinctive prefixes that are essentially never present in non-secret
  // text. Catches them anywhere they leak.
  //   sk-...    : OpenAI
  //   sk-ant-...: Anthropic
  //   gsk_...   : Groq
  //   xai-...   : x.AI
  //   csk-...   : Cerebras
  //   ghp_...   : GitHub personal access token (classic)
  //   github_pat_...: GitHub fine-grained PAT
  //   gho_...   : GitHub OAuth
  { re: /\b(?:sk-(?:ant-|proj-)?|gsk_|xai-|csk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9._\-]{20,}/g,
    fmt: () => "[REDACTED]" },

  // Discord bot token shape (3 dot-separated base64url segments). Real
  // tokens start with M/N/O depending on the snowflake epoch; we accept
  // a wide first-segment length (23-40) because the format isn't a hard
  // contract on the provider side.
  { re: /\b[MNO][A-Za-z0-9_-]{23,40}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{27,}\b/g,
    fmt: () => "[REDACTED]" },

  // JWT-shaped (xxx.yyy.zzz, each segment base64-url, total 60+). Catches
  // Supabase access/refresh tokens, NextAuth session JWTs, etc.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    fmt: () => "[REDACTED]" },

  // Long base64-ish bare strings (50+ chars, mixed-case + digits, no spaces).
  // Last-line defense for "an unknown-shape secret leaked into the body."
  // Anchored on word boundaries so we don't grab fragments of paths or
  // identifiers. Requires at least one lowercase, one uppercase, AND one
  // digit to avoid eating things like `AAAAAAAA...` or pure hex IDs.
  { re: /\b(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{50,}\b/g,
    fmt: () => "[REDACTED]" },
];

/**
 * Escape a string for use as a literal inside a RegExp.
 * Standard ECMAScript-spec sequence; no engine assumptions.
 */
function _escapeReLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the env-value replacement table on demand. Reading `process.env`
 * on every call is cheap (it's a plain object) and means a `setEnv()` call
 * during testing is honored without re-importing the module.
 */
function _envSecretValues() {
  const out = [];
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (!v || v.length < MIN_ENV_VALUE_LEN) continue;
    out.push(v);
  }
  // Sort longest-first so e.g. "abcd12345678" replaces before "abcd1234"
  // when one is a prefix of another. Without this you can leave fragments
  // on disk.
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * Apply env-value substitution + token-shape regex pass.
 *
 * `s` MUST be a string. Callers that hold other types should go through
 * `redactValue()` instead — that one stringifies safely first.
 */
export function redactString(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  let out = s;

  // Pass 1 — known env-var values (highest confidence)
  for (const v of _envSecretValues()) {
    // Escape regex metachars in the env value so it works as a literal find.
    out = out.replace(new RegExp(_escapeReLiteral(v), "g"), "[REDACTED]");
  }

  // Pass 2 — token-shape patterns
  for (const { re, fmt } of TOKEN_PATTERNS) {
    // Each pattern uses /g so a single .replace() walks all hits.
    out = out.replace(re, fmt);
  }

  return out;
}

/**
 * Recursively redact `value`. Returns a redacted **clone** — never mutates
 * the input, never crashes on cycles, never throws.
 *
 * - Strings: through `redactString()`.
 * - Errors: returns `redactString(err.stack || err.message)`. Plain string.
 * - Plain objects / arrays: clone, redact each child up to `maxDepth`.
 * - Anything else (number, bool, null, function, Symbol, BigInt): stringify
 *   safely and run through `redactString()`.
 *
 * Depth-limited so a malicious nested object can't burn the event loop.
 * Cycle-safe via a WeakSet.
 */
export function redactValue(value, maxDepth = 4, _seen = new WeakSet()) {
  if (value == null) return value;

  if (typeof value === "string") return redactString(value);

  if (value instanceof Error) {
    // Prefer the stack (includes message) so error.stack-style logging keeps
    // its full context, just redacted.
    const text = typeof value.stack === "string" ? value.stack : String(value);
    return redactString(text);
  }

  if (typeof value === "object") {
    if (_seen.has(value)) return "[circular]";
    if (maxDepth <= 0) {
      // Can't walk deeper — stringify the current node and redact that.
      try { return redactString(JSON.stringify(value)); }
      catch { return "[unstringifiable]"; }
    }
    _seen.add(value);

    if (Array.isArray(value)) {
      return value.map((v) => redactValue(v, maxDepth - 1, _seen));
    }

    const out = {};
    for (const k of Object.keys(value)) {
      // Don't recurse into known-secret-shaped KEYS — replace the value
      // outright. (Keeps `{ apiKey: "abc" }` from leaking `abc` even if it's
      // too short for any pattern.) Matches: `apiKey`, `api_key`,
      // `access_token`, `refresh_token`, `bearer`, `x-api-key`, plus any
      // field whose name ends in `_token`, `_secret`, or `_key`.
      if (/^(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|bearer|secret|password|pwd|token|x[-_]?api[-_]?key|x[-_]?auth[-_]?token)$/i.test(k)
          || /(_token|_secret|_key|_pwd|_password)$/i.test(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = redactValue(value[k], maxDepth - 1, _seen);
    }
    return out;
  }

  // number, bool, function, BigInt, Symbol → stringify + redact
  try { return redactString(String(value)); }
  catch { return "[unstringifiable]"; }
}

/**
 * Truncate `s` so the on-disk line never exceeds `MAX_LOG_LINE_BYTES`.
 * Length is measured in UTF-8 byte length, not JS-string `.length` (a
 * 4-byte emoji is one `.length` unit but 4 bytes on disk).
 *
 * Appends `…[truncated N bytes]` so an operator can see the cut.
 */
export function truncateLine(s, max = MAX_LOG_LINE_BYTES) {
  if (typeof s !== "string") return s;
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  // Leave room for the truncation marker.
  const marker = `…[truncated ${buf.length - max} bytes]`;
  const room = Math.max(0, max - Buffer.byteLength(marker, "utf8"));
  // Slicing by byte index may split a multi-byte char in half — `toString`
  // will fall back to U+FFFD for that fragment, which is fine; operators
  // see the marker either way.
  return buf.slice(0, room).toString("utf8") + marker;
}

/**
 * Logger entry point. Redacts + truncates a single log line.
 * This is what `log()` in each bot's logger.js calls before doing I/O.
 */
export function redactLogLine(s) {
  if (typeof s !== "string") return redactLogLine(String(s));
  return truncateLine(redactString(s));
}
