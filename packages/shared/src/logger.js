/**
 * @file logger.js
 * @module @defnotean/shared/logger
 *
 * @overview
 * Factory for the bot-side logger that both Eris and Irene share. Returns a
 * `{ log, warn, error, info, redact }` instance bound to a specific log file
 * and (optional) bot prefix. The bot-local `utils/logger.js` becomes a thin
 * wrapper that calls this factory once at module load.
 *
 * Behavior on `log(message)`:
 *   1. Run `message` through `redactLogLine()` so env-var secrets, Bearer/Bot/
 *      MFA tokens, sk- / sk-ant- / gsk_ / ghp_ / JWT-shaped runs, and oversize
 *      payloads (>MAX_LOG_LINE_BYTES) are scrubbed or truncated.
 *   2. Push the redacted line into a 500 ms-batched write queue that rolls the
 *      file at 5 MB to keep disk usage bounded.
 *   3. Mirror the same redacted line to `console.log` with ANSI colors derived
 *      from a `[CATEGORY]` prefix — `[error]`, `[bot]`, `[gemini]`, etc. —
 *      and from heuristic keyword detection (`failed`, `online`, etc.) in the
 *      body.
 *
 * `warn`, `error`, and `info` are aliases for `log` — the existing bot code
 * always calls `log("[CATEGORY] ...")` and conveys severity through the
 * category tag + body keywords, so a richer level API would be ornamental.
 * The aliases are exposed only so future call sites can prefer the obvious
 * name without a wrapper rewrite.
 *
 * @section Why a factory and not a singleton
 * Each bot writes to its own `bot.log` (`packages/eris/bot.log`,
 * `packages/irene/bot.log`) and has a slightly different set of category
 * colors. The factory lets callers pass `logFile` and the category map
 * without making this module mutable global state.
 */
import { appendFile, stat, rename, writeFile } from "fs/promises";
import { redactLogLine, redactValue } from "./logRedact.js";

// 5 MB. Once the active log exceeds this size we rename to `${LOG_FILE}.old`
// (overwriting any previous .old) and start fresh. One generation of history
// is enough for postmortem grep without letting the filesystem grow forever.
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// Buffered write interval. Discord-bot log volume is bursty (one event can
// emit a dozen lines in a tick); batching means file I/O happens at most
// twice a second per logger instance even under burst.
const FLUSH_INTERVAL_MS = 500;

// Pad `[CATEGORY]` field to this width so most messages align on the body.
// Wider categories (e.g. `[longmemory]`) just push the body further right —
// that's intentional rather than truncating a meaningful tag.
const CAT_PAD = 13;

// Respects the NO_COLOR convention. We don't gate on `stdout.isTTY` because
// Render's log viewer renders ANSI fine even though it isn't a real TTY.
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

/**
 * Default category → ANSI color table. Union of the maps the two bots used
 * before consolidation. Lookup is case-insensitive and ignores non-letter
 * characters so `[Shard 0]` → `shard` → cyan. Callers can extend or override
 * via the `extraCategoryColors` option on `createLogger`.
 */
const DEFAULT_CATEGORY_COLORS = {
  // Errors / warnings
  error: C.bRed + C.bold, err: C.bRed + C.bold,
  warn: C.bYellow, warning: C.bYellow,
  // Lifecycle / system
  bot: C.cyan, ready: C.cyan, shard: C.cyan, timers: C.cyan,
  init: C.cyan, startup: C.cyan,
  keepalive: C.gray, perf: C.gray,
  // AI pipeline
  ai: C.magenta, gemini: C.magenta, nvidia: C.magenta,
  exec: C.magenta, executor: C.magenta, schedule: C.magenta,
  // Data / persistence
  db: C.blue, supabase: C.blue,
  // Moderation / security
  gatekeep: C.bYellow + C.bold, security: C.bRed + C.bold,
  modlog: C.yellow, autosetup: C.yellow, autotimeout: C.yellow,
  audit: C.yellow, mod: C.yellow,
  // Economy / games (Eris)
  economy: C.green, shop: C.green, gamble: C.green,
  activity: C.green, pet: C.green, rob: C.green,
  // Music / voice (Irene)
  music: C.green, lavalink: C.green, vc: C.green, tts: C.green,
  voice: C.green, karaoke: C.green,
  // User events
  user: C.gray,
  // Integrations
  youtube: C.red, github: C.gray, twitch: C.magenta,
  bump: C.cyan, reminder: C.cyan, patchbot: C.gray, seasonal: C.cyan,
  longmemory: C.blue, humanity: C.magenta, consciousness: C.magenta,
  personality: C.magenta,
};

// Heuristic body-level tint. Errors / warnings / success-state words pull the
// body color even when the category tag is neutral. Errors ALWAYS look red.
const _ERROR_RE = /\b(error|failed|fatal|crash|rejected|exception|stack)\b/i;
const _WARN_RE  = /\b(warning|warn|slow|retry|retrying|degraded|fallback)\b/i;
const _OK_RE    = /\b(online|ready|success(?:fully)?|connected|started|loaded|cached|restored)\b/i;

/**
 * Build a logger instance bound to a single bot's `bot.log` file.
 *
 * @param {object} opts
 * @param {string} [opts.botPrefix] — informational tag for the bot (e.g.
 *   `"ERIS"` / `"IRENE"`); not embedded in lines (callers already prefix
 *   with `[CATEGORY]`), but reserved for future structured-log adapters.
 * @param {string} opts.logFile — absolute path to the bot.log file.
 * @param {boolean} [opts.redact=true] — set to `false` only in tests that
 *   need to assert on the raw input. Production callers should never disable.
 * @param {number} [opts.maxBytes] — file-rotation threshold; default 5 MB.
 * @param {Record<string,string>} [opts.extraCategoryColors] — per-bot
 *   overrides / additions to the default category color map.
 *
 * @returns {{ log: (m: any) => void, warn: (m: any) => void,
 *             error: (m: any) => void, info: (m: any) => void,
 *             redact: typeof redactValue }}
 */
export function createLogger({
  botPrefix = "",
  logFile,
  redact = true,
  maxBytes = DEFAULT_MAX_BYTES,
  extraCategoryColors = {},
} = {}) {
  void botPrefix; // reserved for future structured-log shippers

  const categoryColors = { ...DEFAULT_CATEGORY_COLORS, ...extraCategoryColors };

  function _categoryColor(cat) {
    const key = cat.toLowerCase().replace(/[^a-z]/g, "");
    return categoryColors[key] || "";
  }

  function _formatForConsole(message) {
    const shortTs = new Date().toISOString().slice(11, 19); // HH:MM:SS
    const tsPart = `${C.dim}${shortTs}${C.reset}`;

    const m = message.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (!m) {
      // No category prefix — tint based on content heuristic
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

    // Body-level tint overlays the category tint — errors ALWAYS look like errors
    const bodyColor = _ERROR_RE.test(rest) ? C.bRed
                    : _WARN_RE.test(rest)  ? C.bYellow
                    : _OK_RE.test(rest)    ? C.bGreen
                    :                        "";

    return `${tsPart}  ${catColor}${catField}${C.reset}${pad} ${bodyColor}${rest}${C.reset}`;
  }

  // Async write queue — batches lines on FLUSH_INTERVAL_MS so file I/O never
  // blocks the event loop and bursty logs coalesce into a single appendFile.
  let _buffer = [];
  let _timer = null;

  function _scheduleFlush() {
    if (_timer) return;
    _timer = setTimeout(async () => {
      _timer = null;
      if (!_buffer.length) return;
      const lines = _buffer.join("");
      _buffer = [];
      if (!logFile) return; // console-only mode
      try {
        const s = await stat(logFile).then((x) => x.size).catch(() => 0);
        if (s >= maxBytes) {
          await rename(logFile, logFile + ".old").catch(() => {});
          await writeFile(logFile, "").catch(() => {});
        }
        await appendFile(logFile, lines);
      } catch (err) {
        // Don't recurse through `log()` — that would re-enter the queue.
        // eslint-disable-next-line no-console
        console.error(`[Logger] File write failed: ${err.message}`);
      }
    }, FLUSH_INTERVAL_MS);
  }

  function log(message) {
    // Last-mile redaction. If a caller passed a non-string (e.g. a raw Error),
    // stringify first; otherwise scan-and-replace for env-var values + token-
    // shaped substrings, then truncate to MAX_LOG_LINE_BYTES. Cheap insurance
    // against future callers that forget to sanitize.
    let safeMessage;
    if (redact) {
      safeMessage = typeof message === "string"
        ? redactLogLine(message)
        : redactLogLine(typeof message === "object" ? JSON.stringify(redactValue(message)) : String(message));
    } else {
      safeMessage = typeof message === "string" ? message : String(message);
    }

    const fullTs = new Date().toISOString().slice(0, 19).replace("T", " ");
    // File line: plain text so grep/tail stay readable and ANSI never leaks
    _buffer.push(`[${fullTs}] ${safeMessage}\n`);
    _scheduleFlush();
    // Console line: pretty
    // eslint-disable-next-line no-console
    console.log(_formatForConsole(safeMessage));
  }

  // Aliases — existing callers always use `log` with a `[CATEGORY]` tag, so
  // these are forward-compatible no-ops. Kept so a future caller that prefers
  // `error(...)` reads naturally without a wrapper.
  return {
    log,
    warn: log,
    error: log,
    info: log,
    redact: redactValue,
  };
}
