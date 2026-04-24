// ─── Logger — pretty console, plain file ───────────────────────────────────

import { getGuildSettings, setLogChannel } from "../database.js";
import { modEmbed } from "./embeds.js";
import { appendFile, stat, rename, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const LOG_CHANNEL_NAMES = [
  "mod-log", "mod-logs", "modlog", "modlogs",
  "audit-log", "audit-logs", "auditlog", "auditlogs",
  "bot-log", "bot-logs", "server-log", "server-logs", "logs",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "../bot.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

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

// Category → ANSI color. Lookup is case-insensitive and ignores non-letter
// characters so "[Shard 0]" → "shard" → cyan.
const CATEGORY_COLORS = {
  // Errors / warnings
  error: C.bRed + C.bold, err: C.bRed + C.bold,
  warn: C.bYellow, warning: C.bYellow,
  // Lifecycle / system
  bot: C.cyan, ready: C.cyan, shard: C.cyan, timers: C.cyan,
  init: C.cyan, startup: C.cyan,
  keepalive: C.gray, perf: C.gray,
  // AI pipeline
  gemini: C.magenta, nvidia: C.magenta, ai: C.magenta,
  exec: C.magenta, executor: C.magenta, schedule: C.magenta,
  // Data / persistence
  db: C.blue, supabase: C.blue,
  // Moderation / security
  gatekeep: C.bYellow + C.bold, security: C.bRed + C.bold,
  modlog: C.yellow, autosetup: C.yellow, autotimeout: C.yellow,
  audit: C.yellow, mod: C.yellow,
  // Music / voice
  music: C.green, lavalink: C.green, vc: C.green, tts: C.green,
  voice: C.green, karaoke: C.green,
  // User events
  user: C.gray,
  // Integrations
  youtube: C.red, github: C.gray, twitch: C.magenta,
  bump: C.cyan, reminder: C.cyan, seasonal: C.cyan,
  longmemory: C.blue, humanity: C.magenta, consciousness: C.magenta,
  personality: C.magenta, patchbot: C.gray,
};

function _categoryColor(cat) {
  const key = cat.toLowerCase().replace(/[^a-z]/g, "");
  return CATEGORY_COLORS[key] || "";
}

// Heuristic level detection from message body.
const _ERROR_RE = /\b(error|failed|fatal|crash|rejected|exception|stack)\b/i;
const _WARN_RE  = /\b(warning|warn|slow|retry|retrying|degraded|fallback)\b/i;
const _OK_RE    = /\b(online|ready|success(?:fully)?|connected|started|loaded|cached|restored)\b/i;

// Pad [CATEGORY] field to 12 chars for alignment on typical messages. Longer
// category names just push the body a bit further right — intentional.
const CAT_PAD = 13;

function _formatForConsole(message) {
  const now = new Date();
  const shortTs = now.toISOString().slice(11, 19); // HH:MM:SS
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

// ── Async write queue — batches lines every 500ms so file I/O never blocks ──
let _logBuffer = [];
let _logFlushTimer = null;

function _scheduleFlush() {
  if (_logFlushTimer) return;
  _logFlushTimer = setTimeout(async () => {
    _logFlushTimer = null;
    if (!_logBuffer.length) return;
    const lines = _logBuffer.join("");
    _logBuffer = [];
    try {
      const size = await stat(LOG_FILE).then((s) => s.size).catch(() => 0);
      if (size >= LOG_MAX_BYTES) {
        await rename(LOG_FILE, LOG_FILE + ".old").catch(() => {});
        await writeFile(LOG_FILE, "").catch(() => {});
      }
      await appendFile(LOG_FILE, lines);
    } catch (err) { console.error(`[Logger] File write failed: ${err.message}`); }
  }, 500);
}

export function log(message) {
  const fullTs = new Date().toISOString().slice(0, 19).replace("T", " ");
  // File line: plain text so grep/tail stay readable and ANSI never leaks
  _logBuffer.push(`[${fullTs}] ${message}\n`);
  _scheduleFlush();
  // Console line: pretty
  console.log(_formatForConsole(message));
}

/**
 * Send a mod-log. Accepts either a single embed (legacy) or a payload object
 * `{ embed, components }` for attaching buttons (e.g. undo actions).
 */
export async function sendModLog(guild, embedOrPayload) {
  // Bail if the bot is no longer in this guild (kicked / gatekept / left mid-event).
  // Prevents auto-detecting + persisting log channels in servers we won't stay in.
  if (!guild?.members?.me) return;
  if (!guild.client?.guilds?.cache?.has(guild.id)) return;

  const settings = getGuildSettings(guild.id);
  let channelId = settings?.log_channel;

  if (!channelId) {
    const found = guild.channels.cache.find(
      (c) => c.isTextBased() && LOG_CHANNEL_NAMES.includes(c.name.toLowerCase())
    );
    if (!found) return;
    channelId = found.id;
    setLogChannel(guild.id, found.id);
    log(`[AutoSetup] "${guild.name}": auto-detected log channel #${found.name}`);
  }

  let channel = guild.channels.cache.get(channelId);
  if (!channel) channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Normalize input: single embed → payload shape
  const payload = (embedOrPayload && typeof embedOrPayload === "object" && "embed" in embedOrPayload)
    ? { embeds: [embedOrPayload.embed], components: embedOrPayload.components ?? [] }
    : { embeds: [embedOrPayload] };

  try {
    await channel.send(payload);
  } catch (err) { log(`[ModLog] Failed to send log to #${channel.name}: ${err.message}`); }
}
