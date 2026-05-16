// ─── Logger — pretty console, plain file ───────────────────────────────────

import { appendFile, stat, rename } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { redactLogLine, redactValue } from "@defnotean/shared/logRedact";

// Re-export so callers that want to manually redact a structured value (e.g.
// `log(\`tool: \${name}(\${JSON.stringify(redact(args))})\`)`) don't need to
// reach into @defnotean/shared themselves.
export { redactValue as redact };

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "..", "bot.log");
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// ── ANSI color handling ────────────────────────────────────────────────────
// Respects NO_COLOR env convention; otherwise emits ANSI (Render's log viewer
// renders it fine even without a TTY, so we don't gate on stdout.isTTY).
const COLORS_ON = !process.env.NO_COLOR;

const C = {
  reset:   COLORS_ON ? "\x1b[0m"  : "",
  dim:     COLORS_ON ? "\x1b[2m"  : "",
  bold:    COLORS_ON ? "\x1b[1m"  : "",
  red:     COLORS_ON ? "\x1b[31m" : "",
  green:   COLORS_ON ? "\x1b[32m" : "",
  yellow:  COLORS_ON ? "\x1b[33m" : "",
  blue:    COLORS_ON ? "\x1b[34m" : "",
  magenta: COLORS_ON ? "\x1b[35m" : "",
  cyan:    COLORS_ON ? "\x1b[36m" : "",
  gray:    COLORS_ON ? "\x1b[90m" : "",
  bRed:    COLORS_ON ? "\x1b[91m" : "",
  bYellow: COLORS_ON ? "\x1b[93m" : "",
  bGreen:  COLORS_ON ? "\x1b[92m" : "",
};

const CATEGORY_COLORS = {
  // Errors / warnings
  error: C.bRed + C.bold, err: C.bRed + C.bold,
  warn: C.bYellow, warning: C.bYellow,
  // Lifecycle / system
  bot: C.cyan, ready: C.cyan, shard: C.cyan, timers: C.cyan,
  init: C.cyan, startup: C.cyan,
  keepalive: C.gray, perf: C.gray,
  // AI pipeline
  ai: C.magenta, gemini: C.magenta, nvidia: C.magenta,
  exec: C.magenta, executor: C.magenta,
  // Data / persistence
  db: C.blue, supabase: C.blue,
  // Moderation / security
  gatekeep: C.bYellow + C.bold, security: C.bRed + C.bold,
  modlog: C.yellow, autosetup: C.yellow,
  audit: C.yellow, mod: C.yellow,
  // Economy / games (Eris-specific)
  economy: C.green, shop: C.green, gamble: C.green,
  activity: C.green, pet: C.green, rob: C.green,
  // Music / voice
  music: C.green, lavalink: C.green, vc: C.green,
  // User events
  user: C.gray,
  // Integrations
  youtube: C.red, github: C.gray, twitch: C.magenta,
  bump: C.cyan, reminder: C.cyan, patchbot: C.gray,
};

function _categoryColor(cat) {
  const key = cat.toLowerCase().replace(/[^a-z]/g, "");
  return CATEGORY_COLORS[key] || "";
}

const _ERROR_RE = /\b(error|failed|fatal|crash|rejected|exception|stack)\b/i;
const _WARN_RE  = /\b(warning|warn|slow|retry|retrying|degraded|fallback)\b/i;
const _OK_RE    = /\b(online|ready|success(?:fully)?|connected|started|loaded|cached|restored)\b/i;

const CAT_PAD = 13;

function _formatForConsole(message) {
  const shortTs = new Date().toISOString().slice(11, 19);
  const tsPart = `${C.dim}${shortTs}${C.reset}`;

  const m = message.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) {
    const bodyColor = _ERROR_RE.test(message) ? C.bRed
                    : _WARN_RE.test(message)  ? C.bYellow
                    : _OK_RE.test(message)    ? C.bGreen
                    :                           "";
    return `${tsPart}  ${bodyColor}${message}${C.reset}`;
  }

  const [, cat, rest] = m;
  const catField = `[${cat}]`;
  const pad = " ".repeat(Math.max(0, CAT_PAD - catField.length));
  const catColor = _categoryColor(cat);

  const bodyColor = _ERROR_RE.test(rest) ? C.bRed
                  : _WARN_RE.test(rest)  ? C.bYellow
                  : _OK_RE.test(rest)    ? C.bGreen
                  :                        "";

  return `${tsPart}  ${catColor}${catField}${C.reset}${pad} ${bodyColor}${rest}${C.reset}`;
}

let _buffer = [];
let _timer = null;

export function log(message) {
  // Last-mile redaction. If a caller passed a non-string (e.g. a raw Error),
  // stringify first; otherwise scan-and-replace for env-var values + token-
  // shaped substrings, then truncate to MAX_LOG_LINE_BYTES. Cheap insurance
  // against future callers that forget to sanitize.
  const safeMessage = typeof message === "string"
    ? redactLogLine(message)
    : redactLogLine(typeof message === "object" ? JSON.stringify(redactValue(message)) : String(message));

  const fullTs = new Date().toISOString().slice(0, 19).replace("T", " ");
  _buffer.push(`[${fullTs}] ${safeMessage}\n`);
  if (!_timer) {
    _timer = setTimeout(async () => {
      const lines = _buffer.join("");
      _buffer = [];
      _timer = null;
      try {
        const s = await stat(LOG_FILE).catch(() => ({ size: 0 }));
        if (s.size >= MAX_SIZE) await rename(LOG_FILE, LOG_FILE + ".old").catch(() => {});
        await appendFile(LOG_FILE, lines);
      } catch {}
    }, 500);
  }
  console.log(_formatForConsole(safeMessage));
}
